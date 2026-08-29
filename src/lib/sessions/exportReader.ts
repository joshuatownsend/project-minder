import { createReadStream } from "fs";
import { promises as fs } from "fs";
import path from "path";
import readline from "readline";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
import { getAdapter } from "@/lib/adapters";
import type { SessionDetail } from "@/lib/types";
import type { ExportBlock, ExportMessage, ExportMeta } from "./markdownExport";

/**
 * Impure half of the session exporter: sources the message bodies.
 *
 * Two sources, in preference order:
 *
 * 1. **The session's own JSONL** (`fidelity: "full"`). This is the only
 *    place the verbatim transcript exists. Every in-memory abstraction in
 *    this repo truncates — `SessionDetail.timeline` caps assistant text at
 *    300 chars on the file path and 500 on the DB path, and
 *    `UsageTurn.assistantText` caps at 500 — because they exist to render
 *    lists and feed search, not to reproduce a conversation.
 *
 * 2. **The index** (`fidelity: "index"`), via `SessionDetail.timeline`.
 *    Used when the JSONL is gone (pruned by Claude Code's own retention,
 *    a session synced from another machine, demo mode). Degrading to a
 *    preview-quality export beats a 404, provided the document says so —
 *    which is why `fidelity` rides in the front matter and drives a
 *    warning callout in the rendered header.
 */

/** Same ceiling the ingest path and the scanner use. */
const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/** Guard against a pathological transcript exhausting the render buffer. */
const MAX_MESSAGES = 20_000;

export interface ExportSource {
  messages: ExportMessage[];
  fidelity: ExportMeta["fidelity"];
  /** Set when the JSONL existed but could not be used. */
  degradedReason?: "too-large" | "unreadable" | "not-found";
  /**
   * Usable messages the read cap prevented from loading. Passed to the
   * renderer so the footer and the stats can disclose the gap.
   */
  unread: number;
}

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface RawEntry {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  requestId?: string;
  message?: { id?: string; role?: string; model?: string; content?: unknown };
  /**
   * Some user entries carry their blocks here rather than under
   * `message.content` — a supported Claude JSONL shape that the existing
   * scanner explicitly falls back to (`claudeConversations.ts`). Reading only
   * `message.content` dropped those turns entirely while the export still
   * claimed `fidelity: "full"`.
   */
  content?: unknown;
}

/**
 * Flatten a `tool_result` block's `content`, which Claude Code writes as
 * either a bare string or an array of `{type: "text", text}` parts.
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      const block = part as RawBlock;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      // Images and other non-text results have no markdown representation;
      // name them rather than dropping them silently.
      return block?.type ? `[${block.type}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Turn one JSONL entry into a message, or null when it carries nothing a
 * reader wants (`system` bookkeeping, `isMeta` harness injections, an
 * entry whose every block was empty).
 *
 * `toolNames` is threaded in so a `tool_result` on a user turn can be
 * labelled with the tool that produced it — the result block itself
 * carries only `tool_use_id`.
 */
export function entryToMessage(
  entry: RawEntry,
  toolNames: Map<string, string>,
): ExportMessage | null {
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  if (entry.isMeta) return null;

  // Prefer `message.content`, but fall back to the top-level `content` when
  // it is absent OR an empty array — an empty array is exactly how an entry
  // that stores its blocks at the top level presents.
  const inner = entry.message?.content;
  const content =
    inner === undefined || (Array.isArray(inner) && inner.length === 0) ? entry.content ?? inner : inner;
  const blocks: ExportBlock[] = [];

  if (typeof content === "string") {
    // User turns are frequently a bare string rather than a block array.
    if (content.trim()) blocks.push({ kind: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const raw of content as RawBlock[]) {
      if (!raw || typeof raw !== "object") continue;
      switch (raw.type) {
        case "text":
          if (typeof raw.text === "string" && raw.text.trim()) {
            blocks.push({
              kind: entry.isApiErrorMessage ? "error" : "text",
              text: raw.text,
            });
          }
          break;
        case "thinking":
          if (typeof raw.thinking === "string" && raw.thinking.trim()) {
            blocks.push({ kind: "thinking", text: raw.thinking });
          }
          break;
        case "tool_use": {
          const name = typeof raw.name === "string" ? raw.name : "tool";
          if (typeof raw.id === "string") toolNames.set(raw.id, name);
          blocks.push({
            kind: "tool_use",
            toolName: name,
            toolUseId: typeof raw.id === "string" ? raw.id : undefined,
            input:
              raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)
                ? (raw.input as Record<string, unknown>)
                : undefined,
          });
          break;
        }
        case "tool_result": {
          const text = toolResultText(raw.content);
          if (!text.trim()) break;
          blocks.push({
            kind: "tool_result",
            text,
            toolUseId: raw.tool_use_id,
            toolName: raw.tool_use_id ? toolNames.get(raw.tool_use_id) : undefined,
            isError: raw.is_error === true,
          });
          break;
        }
        case "image":
          // A pasted screenshot has no markdown representation, but silently
          // dropping it made part of a prompt disappear from a document
          // labelled full fidelity. Name it instead.
          blocks.push({ kind: "text", text: "_[image attachment omitted — not representable in markdown]_" });
          break;
        default:
          break;
      }
    }
  }

  if (blocks.length === 0) return null;
  return {
    role: entry.type === "assistant" ? "assistant" : "user",
    timestamp: entry.timestamp,
    model: entry.message?.model,
    isSidechain: entry.isSidechain === true,
    blocks,
  };
}

/**
 * Identity of one export block, for collapsing a genuine re-log.
 *
 * `tool_use` keys on `tool_use_id` where present — the measured re-emissions on
 * the ingest path repeat theirs, which is what makes block-level dedupe a
 * sufficient replacement for dropping the whole line. Everything else keys on
 * its body, since two distinct blocks with identical text are indistinguishable
 * and collapsing them is the same call the message-level guard already made.
 */
function blockKey(b: ExportBlock): string {
  if (b.kind === "tool_use" && b.toolUseId) return `u:${b.toolUseId}`;
  return `${b.kind}:${b.toolName ?? ""}:${b.text ?? ""}:${b.input ? JSON.stringify(b.input) : ""}`;
}

export interface JsonlReadResult {
  messages: ExportMessage[];
  /**
   * Usable entries the read cap prevented from loading. Non-zero means the
   * export is incomplete, and the renderer discloses it — a cap that stopped
   * silently made a truncated export read as a whole one.
   */
  unread: number;
  /**
   * Genuine re-emissions of an assistant message that were collapsed — lines
   * whose every block was already present. A continuation line carrying new
   * content is merged instead and does NOT count here.
   */
  duplicates: number;
}

/**
 * Read and parse a session JSONL into export messages.
 *
 * Assistant lines are grouped by `message.id` (falling back to `requestId`),
 * which is the same identity rule `parseSessionTurns` applies. Claude Code
 * re-logs an assistant message on a retry or a resumed-session re-emit, and
 * without collapsing those the export repeats the reply and its tool calls,
 * inflates its own message count, and burns through the read cap early.
 *
 * #453: grouping is not the same as *discarding*, and this used to discard.
 * Claude Code writes one JSONL line per content block, so a repeat id is far
 * more often the same message CONTINUING than a re-log — and the trailing lines
 * are the ones carrying `tool_use` blocks. Dropping them cost the export its
 * tool calls and any prose that arrived after the first block, then reported
 * the loss as `duplicates`, which read as "we tidied a re-log up for you"
 * rather than "content is missing". Blocks are therefore merged into the
 * message the id already owns, deduped at block level so a real re-log still
 * collapses and the counter keeps meaning what it says.
 */
export async function readJsonlMessages(filePath: string): Promise<JsonlReadResult> {
  const messages: ExportMessage[] = [];
  const toolNames = new Map<string, string>();
  /** `message.id` → where that message's blocks live, and what it already has. */
  const openAssistant = new Map<string, { index: number; blockKeys: Set<string> }>();
  let unread = 0;
  let duplicates = 0;
  let capped = false;

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(line) as RawEntry;
      } catch {
        // A torn final line is normal for a session still being written.
        continue;
      }

      const identity = entry.type === "assistant" ? entry.message?.id ?? entry.requestId : undefined;
      const open = identity ? openAssistant.get(identity) : undefined;

      // Resolve open identities BEFORE the cap, so a message we chose to keep
      // is never left half-read.
      //
      // The cap counts MESSAGES, and a continuation is not one — it is more of
      // a message already inside the cap. With the cap checked first, a split
      // message whose first line happened to be the 20,000th would keep that
      // line and route its remaining lines through the unread branch: the
      // retained message silently loses its tool calls, and each dropped block
      // inflates `unread` as though it were a separate message. Both numbers
      // then misdescribe the export in the same direction. (Codex, PR #468.)
      if (open) {
        // Continuation (or re-log) of a message already emitted. Fold in only
        // the blocks it does not already have; if that is none, it really was
        // a re-emission and the counter says so.
        const more = entryToMessage(entry, toolNames);
        let added = 0;
        for (const block of more?.blocks ?? []) {
          const key = blockKey(block);
          if (open.blockKeys.has(key)) continue;
          open.blockKeys.add(key);
          messages[open.index].blocks.push(block);
          added++;
        }
        if (added === 0) duplicates++;
        continue;
      }

      // Keep counting past the cap rather than breaking: the whole point is
      // to be able to say HOW MANY messages were left out, and `break` threw
      // that number away.
      if (capped) {
        if (entryToMessage(entry, toolNames)) unread++;
        continue;
      }

      const message = entryToMessage(entry, toolNames);
      if (!message) continue;
      messages.push(message);
      if (identity) {
        openAssistant.set(identity, {
          index: messages.length - 1,
          blockKeys: new Set(message.blocks.map(blockKey)),
        });
      }
      if (messages.length >= MAX_MESSAGES) capped = true;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { messages, unread, duplicates };
}

/**
 * Reconstruct messages from the index's timeline. Lossy by construction —
 * see the `fidelity` note at the top of this file.
 *
 * The timeline is a flat event list, so consecutive events of the same
 * role are folded back into one message; that is what makes an assistant
 * turn's text and its tool calls render as a single section rather than
 * one heading per block.
 */
export function timelineToMessages(detail: SessionDetail): ExportMessage[] {
  const messages: ExportMessage[] = [];

  for (const event of detail.timeline ?? []) {
    const role: ExportMessage["role"] = event.type === "user" ? "user" : "assistant";
    const block: ExportBlock | null =
      event.type === "user" || event.type === "assistant"
        ? event.content
          ? { kind: "text", text: event.content }
          : null
        : event.type === "thinking"
          ? // The DB path stores thinking out-of-line and leaves `content`
            // empty here, lazy-fetching it on expand. Nothing to export.
            event.content
            ? { kind: "thinking", text: event.content }
            : null
          : event.type === "error"
            ? { kind: "error", text: event.content }
            : {
                kind: "tool_use",
                toolName: event.toolName,
                toolUseId: event.toolUseId,
                input: event.toolInput,
              };
    if (!block) continue;

    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.blocks.push(block);
    } else {
      messages.push({ role, timestamp: event.timestamp, blocks: [block] });
    }
  }
  return messages;
}

/**
 * Load the best available message source for `sessionId`.
 *
 * `detail` is required rather than re-fetched: the caller already has it
 * (it supplies the export metadata), and it is also the fallback body
 * source, so passing it keeps this function to a single I/O decision.
 */
export async function loadExportSource(
  sessionId: string,
  detail: SessionDetail,
  options: { sidechains?: boolean } = {},
): Promise<ExportSource> {
  const located = await locateTranscript(sessionId, detail.source);

  if (!located) {
    return {
      messages: timelineToMessages(detail),
      fidelity: "index",
      degradedReason: "not-found",
      unread: 0,
    };
  }

  try {
    const stat = await fs.stat(located.filePath);
    if (stat.size > MAX_SESSION_FILE_SIZE) {
      return {
        messages: timelineToMessages(detail),
        fidelity: "index",
        degradedReason: "too-large",
        unread: 0,
      };
    }
    const { messages, unread } = await readJsonlMessages(located.filePath);
    // An empty parse means the file exists but yielded nothing usable
    // (all-meta, or a schema we don't recognize) — the index is strictly
    // better than an empty document.
    if (messages.length === 0) {
      return {
        messages: timelineToMessages(detail),
        fidelity: "index",
        degradedReason: "unreadable",
        unread: 0,
      };
    }

    let subUnread = 0;
    if (options.sidechains) {
      const sub = await readSubagentMessages(located.filePath);
      subUnread = sub.unread;
      if (sub.messages.length > 0) {
        // Appended rather than interleaved: subagent files carry their own
        // timelines and merging them by timestamp would imply an ordering
        // relationship across processes that the data doesn't support.
        messages.push(...sub.messages);
      }
    }

    return { messages, fidelity: "full", unread: unread + subUnread };
  } catch {
    return {
      messages: timelineToMessages(detail),
      fidelity: "index",
      degradedReason: "unreadable",
      unread: 0,
    };
  }
}

/**
 * Find the transcript file for a session.
 *
 * `resolveSessionJsonl` only walks Claude's `projects/<dir>/<id>.jsonl`
 * layout, so a Codex or Gemini session always missed and fell back to the
 * index previews — the export silently became preview-quality for every
 * non-Claude session even though the raw transcript was sitting on disk.
 *
 * Claude keeps the fast path (a direct filename probe). Other adapters are
 * asked to `discover()` and the result is matched on basename, which is the
 * only session identity the `SessionFile` contract exposes. That walk is the
 * reason it is not used for Claude too: this runs on an explicit user action,
 * but there is no need to pay for it when a direct lookup works.
 */
async function locateTranscript(
  sessionId: string,
  source: string | undefined,
): Promise<{ filePath: string } | null> {
  if (!source || source === "claude") {
    try {
      // DYNAMIC, and it has to be. `indexedSessionPath` reaches `db/connection`,
      // which freezes the `~/.minder` path constant at module-evaluation time —
      // so a STATIC import here would put it on the graph of every test that
      // imports this module, before any of them can install an isolated home.
      // `tests/dbIsolationGuard` enforces that, and caught this import when it
      // was static. Same reason `data/index.ts` lazy-loads its own DB modules.
      const { indexedSessionPath } = await import("@/lib/data/indexedSessionPath");
      return await resolveSessionJsonl(sessionId, { indexedPath: indexedSessionPath });
    } catch {
      return null;
    }
  }

  try {
    const adapter = getAdapter(source);
    if (!adapter) return null;
    const files = await adapter.discover();
    const match = files.find((f) => {
      // `path.parse` rather than a regex: this string has been through a
      // shell heredoc more than once, and every escaping mistake here fails
      // silently as "session not found" and a preview-quality export.
      const base = path.basename(f.filePath);
      return base === sessionId || path.parse(base).name === sessionId;
    });
    return match ? { filePath: match.filePath } : null;
  } catch {
    return null;
  }
}

/**
 * Read modern subagent transcripts.
 *
 * As of Claude Code ~v2.1.150 subagent conversations no longer appear as
 * `isSidechain` entries inside the parent session file (the scanner documents
 * probing 0/214 sessions for them). They live in a sibling directory:
 * `<project-dir>/<session-id>/subagents/agent-*.jsonl`. Without reading those,
 * `detail=full` and `sidechains=1` promised subagent content and delivered
 * none — and reported zero excluded messages while doing it.
 *
 * Best-effort throughout: a missing directory or an unreadable file yields
 * fewer messages, never an error.
 */
async function readSubagentMessages(
  parentFilePath: string,
): Promise<{ messages: ExportMessage[]; unread: number }> {
  // Derived from the RESOLVED PATH, not from the session id (#486).
  //
  // Taking the id and assuming `<project-dir>/<id>/subagents` was correct only
  // for a FLAT transcript. `resolveSessionJsonl` now also returns nested
  // subagent transcripts at `<project-dir>/<parent>/subagents/<id>.jsonl`, and
  // for one of those the id-based derivation named
  // `<…>/subagents/<id>/subagents` — a directory that is not the sibling of the
  // file that was actually found.
  //
  // The basename and the id are the same string today. Deriving from the path
  // is not a no-op for that reason: it is what stops this making a claim about
  // LAYOUT that the resolver has already answered.
  const base = path.basename(parentFilePath, ".jsonl");
  const dir = path.join(path.dirname(parentFilePath), base, "subagents");
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".jsonl")).sort();
  } catch {
    return { messages: [], unread: 0 };
  }

  const out: ExportMessage[] = [];
  let unread = 0;
  for (const [i, name] of entries.entries()) {
    // Stopping here without counting would report fidelity "full" over a
    // document missing whole agents — the same silent-cap failure the parent
    // read already had to fix. Count what is left rather than dropping it.
    if (out.length >= MAX_MESSAGES) {
      unread += entries.length - i;
      break;
    }
    try {
      const result = await readJsonlMessages(path.join(dir, name));
      unread += result.unread;
      for (const m of result.messages) out.push({ ...m, isSidechain: true });
    } catch {
      // One unreadable agent file must not lose the others.
    }
  }
  return { messages: out, unread };
}

/** Assemble the front-matter metadata from an already-loaded detail. */
export function toExportMeta(detail: SessionDetail, fidelity: ExportMeta["fidelity"]): ExportMeta {
  return {
    sessionId: detail.sessionId,
    projectName: detail.projectName,
    projectPath: detail.projectPath,
    projectSlug: detail.projectSlug,
    title: detail.generatedTitle,
    gitBranch: detail.gitBranch,
    startTime: detail.startTime,
    endTime: detail.endTime,
    durationMs: detail.durationMs,
    costEstimate: detail.costEstimate,
    modelsUsed: detail.modelsUsed,
    messageCount: detail.messageCount,
    fidelity,
  };
}
