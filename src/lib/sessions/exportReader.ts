import { createReadStream } from "fs";
import { promises as fs } from "fs";
import readline from "readline";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
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
  message?: { role?: string; model?: string; content?: unknown };
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

  const content = entry.message?.content;
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

/** Read and parse a session JSONL into export messages. */
export async function readJsonlMessages(filePath: string): Promise<ExportMessage[]> {
  const messages: ExportMessage[] = [];
  const toolNames = new Map<string, string>();

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
      const message = entryToMessage(entry, toolNames);
      if (!message) continue;
      messages.push(message);
      if (messages.length >= MAX_MESSAGES) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return messages;
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
): Promise<ExportSource> {
  let located: { filePath: string } | null = null;
  try {
    located = await resolveSessionJsonl(sessionId);
  } catch {
    located = null;
  }

  if (!located) {
    return { messages: timelineToMessages(detail), fidelity: "index", degradedReason: "not-found" };
  }

  try {
    const stat = await fs.stat(located.filePath);
    if (stat.size > MAX_SESSION_FILE_SIZE) {
      return { messages: timelineToMessages(detail), fidelity: "index", degradedReason: "too-large" };
    }
    const messages = await readJsonlMessages(located.filePath);
    // An empty parse means the file exists but yielded nothing usable
    // (all-meta, or a schema we don't recognize) — the index is strictly
    // better than an empty document.
    if (messages.length === 0) {
      return {
        messages: timelineToMessages(detail),
        fidelity: "index",
        degradedReason: "unreadable",
      };
    }
    return { messages, fidelity: "full" };
  } catch {
    return { messages: timelineToMessages(detail), fidelity: "index", degradedReason: "unreadable" };
  }
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
