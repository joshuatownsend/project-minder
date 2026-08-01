/**
 * Session → Markdown export (pure).
 *
 * Turns a parsed transcript into one readable, self-contained markdown
 * document. No filesystem, no DB, no `server-only` — the whole module is
 * a function of its inputs so the formatting rules can be tested directly.
 * `exportReader.ts` is the impure half that sources the messages.
 *
 * Two properties this module is responsible for and nothing else is:
 *
 * 1. **Fence safety.** Session content is full of markdown, including
 *    triple-backtick fences. Wrapping a tool result in ``` closes the
 *    block at the transcript's *first* embedded fence and renders the
 *    remainder of the document as prose. Every fence emitted here is
 *    sized to exceed the longest backtick run in its own content.
 *
 * 2. **Visible truncation.** The point of the export is that a 15 MB
 *    JSONL becomes a document a person can read, which means dropping
 *    bytes. Every drop is either announced inline (`… truncated N
 *    characters`) or counted in the returned `ExportStats`, so the
 *    caller can say what was left out. A silent cap would make the
 *    export look complete when it isn't.
 */

/** One content block within a message, already normalized off the wire. */
export interface ExportBlock {
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "error";
  text?: string;
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

export interface ExportMessage {
  role: "user" | "assistant";
  timestamp?: string;
  model?: string;
  /** Subagent (sidechain) turns; excluded unless `sidechains` is on. */
  isSidechain?: boolean;
  blocks: ExportBlock[];
}

/**
 * Where the message bodies came from.
 * - `full`  — the session's own JSONL, verbatim.
 * - `index` — the SQLite index / scan cache, whose text columns are
 *   previews (300–500 chars per turn). Usable, but not the transcript.
 */
export type ExportFidelity = "full" | "index";

export interface ExportMeta {
  sessionId: string;
  projectName?: string;
  projectPath?: string;
  projectSlug?: string;
  title?: string;
  gitBranch?: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  costEstimate?: number;
  modelsUsed?: string[];
  messageCount?: number;
  fidelity: ExportFidelity;
}

export const EXPORT_DETAILS = ["minimal", "standard", "full"] as const;
export type ExportDetail = (typeof EXPORT_DETAILS)[number];

export function isExportDetail(value: unknown): value is ExportDetail {
  return typeof value === "string" && (EXPORT_DETAILS as readonly string[]).includes(value);
}

export interface ExportOptions {
  detail?: ExportDetail;
  /** Per-toggle overrides. Absent means "whatever the detail preset says". */
  thinking?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  sidechains?: boolean;
  /** Cap on prose (user/assistant/thinking) per block. `null` = uncapped. */
  maxTextChars?: number | null;
  /** Cap on tool input + tool result per block. `null` = uncapped. */
  maxToolChars?: number | null;
  /** Injected so the rendered document is deterministic under test. */
  exportedAt?: string;
}

export interface ResolvedExportOptions {
  detail: ExportDetail;
  thinking: boolean;
  toolCalls: boolean;
  toolResults: boolean;
  sidechains: boolean;
  maxTextChars: number | null;
  maxToolChars: number | null;
  exportedAt: string | null;
}

interface Preset {
  thinking: boolean;
  toolCalls: boolean;
  toolResults: boolean;
  sidechains: boolean;
  maxTextChars: number | null;
  maxToolChars: number | null;
}

/**
 * `standard` is the default because it is the one that achieves the
 * headline compression: tool *calls* are cheap and carry the narrative
 * ("it ran the tests"), tool *results* are where the megabytes live, and
 * thinking is both the largest single contributor and the least useful
 * to a reader who wasn't there.
 */
const PRESETS: Record<ExportDetail, Preset> = {
  minimal: {
    thinking: false,
    toolCalls: false,
    toolResults: false,
    sidechains: false,
    maxTextChars: 4_000,
    maxToolChars: 0,
  },
  standard: {
    thinking: false,
    toolCalls: true,
    toolResults: true,
    sidechains: false,
    maxTextChars: 12_000,
    maxToolChars: 1_500,
  },
  full: {
    thinking: true,
    toolCalls: true,
    toolResults: true,
    sidechains: true,
    maxTextChars: null,
    maxToolChars: 8_000,
  },
};

/** Hard ceiling on caller-supplied caps, including `full`'s uncapped prose. */
const MAX_CAP = 5_000_000;

function clampCap(value: number | null | undefined, fallback: number | null): number | null {
  if (value === null) return null;
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_CAP, Math.floor(value)));
}

export function resolveExportOptions(options: ExportOptions = {}): ResolvedExportOptions {
  const detail = isExportDetail(options.detail) ? options.detail : "standard";
  const preset = PRESETS[detail];
  return {
    detail,
    thinking: options.thinking ?? preset.thinking,
    toolCalls: options.toolCalls ?? preset.toolCalls,
    toolResults: options.toolResults ?? preset.toolResults,
    sidechains: options.sidechains ?? preset.sidechains,
    maxTextChars: clampCap(options.maxTextChars, preset.maxTextChars),
    maxToolChars: clampCap(options.maxToolChars, preset.maxToolChars),
    exportedAt: options.exportedAt ?? null,
  };
}

export interface ExportStats {
  /** Messages actually rendered (after sidechain filtering). */
  messages: number;
  /** Messages skipped because they were subagent turns. */
  sidechainsSkipped: number;
  blocks: number;
  /** Blocks omitted entirely by the detail level (thinking, tool I/O). */
  blocksOmitted: number;
  /** Blocks rendered but cut short; each carries an inline marker. */
  blocksTruncated: number;
  /** Characters removed by truncation. */
  charsTruncated: number;
  bytes: number;
}

export interface ExportResult {
  markdown: string;
  stats: ExportStats;
}

// ─── Fencing ─────────────────────────────────────────────────────────────────

/**
 * Pick a fence longer than any backtick run inside `content`.
 * CommonMark closes a fenced block only on a run of *at least* the
 * opening length, so `n+1` backticks can safely wrap content whose
 * longest run is `n`.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  const runs = content.match(/`+/g);
  if (runs) for (const run of runs) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function codeBlock(content: string, lang = ""): string {
  const fence = fenceFor(content);
  // A body ending in a backtick would otherwise butt against the closing
  // fence and extend its run; the newline keeps them separate.
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** Collapse to one line and escape the pipes/backticks a table cell can't hold. */
function inlineCell(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return cut.replace(/\|/g, "\\|");
}

// ─── Front matter ────────────────────────────────────────────────────────────

/**
 * YAML front matter with every scalar JSON-quoted. Project names and
 * branches routinely contain `:`, `#`, and `\` (Windows paths), all of
 * which change meaning in bare YAML. JSON string syntax is a subset of
 * YAML's double-quoted scalar, so `JSON.stringify` is both correct and
 * dependency-free here.
 */
function frontMatter(rows: [string, string | number | string[] | undefined][]): string {
  const lines = ["---"];
  for (const [key, value] of rows) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${Number.isFinite(value) ? value : 0}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** `HH:MM:SS` in UTC, or undefined for an unparseable stamp. */
function clockTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(11, 19);
}

/** One-line gist of a tool call, from whichever argument carries the intent. */
export function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of ["file_path", "command", "pattern", "path", "url", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return inlineCell(value);
  }
  return "";
}

// ─── Renderer ────────────────────────────────────────────────────────────────

class Writer {
  readonly lines: string[] = [];
  readonly stats: ExportStats = {
    messages: 0,
    sidechainsSkipped: 0,
    blocks: 0,
    blocksOmitted: 0,
    blocksTruncated: 0,
    charsTruncated: 0,
    bytes: 0,
  };

  push(line: string): void {
    this.lines.push(line);
  }

  /**
   * Emit a blank separator line, collapsing runs.
   *
   * Deliberately done at emit time rather than by post-processing the
   * finished document (a `\n{3,}` collapse over the whole string). That
   * regex cannot tell a gap the renderer emitted from three newlines
   * inside a tool result, so it would quietly rewrite the transcript —
   * the precise infidelity this exporter exists to avoid. Content
   * strings are never touched once pushed.
   */
  blank(): void {
    if (this.lines.length === 0) return;
    if (this.lines[this.lines.length - 1] === "") return;
    this.lines.push("");
  }

  /**
   * Cut `text` to `cap`, recording the loss and announcing it inline.
   * `cap === null` means uncapped; `cap === 0` means the block is dropped
   * by the detail level, which the caller handles before getting here.
   */
  truncate(text: string, cap: number | null): string {
    if (cap === null || text.length <= cap) return text;
    const dropped = text.length - cap;
    this.stats.blocksTruncated++;
    this.stats.charsTruncated += dropped;
    return `${text.slice(0, cap)}\n… truncated ${dropped.toLocaleString("en-US")} characters`;
  }
}

export function renderSessionMarkdown(
  meta: ExportMeta,
  messages: ExportMessage[],
  options: ExportOptions = {},
): ExportResult {
  const opts = resolveExportOptions(options);
  const w = new Writer();

  const title = meta.title?.trim() || `Session ${meta.sessionId}`;
  const visible = messages.filter((m) => {
    if (m.isSidechain && !opts.sidechains) {
      w.stats.sidechainsSkipped++;
      return false;
    }
    return true;
  });

  w.push(
    frontMatter([
      ["session", meta.sessionId],
      ["title", title],
      ["project", meta.projectName],
      ["project_path", meta.projectPath],
      ["branch", meta.gitBranch],
      ["started", meta.startTime],
      ["ended", meta.endTime],
      ["duration", formatDuration(meta.durationMs)],
      ["models", meta.modelsUsed],
      ["messages", visible.length],
      ["cost_usd", meta.costEstimate === undefined ? undefined : Number(meta.costEstimate.toFixed(4))],
      ["detail", opts.detail],
      ["fidelity", meta.fidelity],
      ["exported", opts.exportedAt ?? undefined],
      ["exported_by", "Project Minder"],
    ]),
  );
  w.blank();
  w.push(`# ${title}`);
  w.blank();

  // Subtitle line: the facts a reader needs before deciding to read on.
  const facts: string[] = [];
  if (meta.projectName) facts.push(meta.projectName);
  if (meta.startTime) facts.push(meta.startTime.slice(0, 10));
  const duration = formatDuration(meta.durationMs);
  if (duration) facts.push(duration);
  facts.push(`${visible.length} message${visible.length === 1 ? "" : "s"}`);
  if (meta.costEstimate !== undefined) facts.push(`$${meta.costEstimate.toFixed(2)}`);
  if (facts.length) {
    w.push(`> ${facts.join(" · ")}`);
    w.blank();
  }

  if (meta.fidelity === "index") {
    // Loud, because the difference is invisible from inside the document:
    // index-sourced prose looks like a short message, not a cut one.
    w.push("> [!WARNING]");
    w.push("> **Reduced fidelity.** This session's transcript file was unavailable, so the");
    w.push("> text below came from Project Minder's index, where each turn is stored as a");
    w.push("> preview (a few hundred characters). Message bodies are cut off at the source —");
    w.push("> the caps below did not do it.");
    w.blank();
  }

  w.push("---");
  w.blank();

  for (const message of visible) {
    renderMessage(w, message, opts);
  }

  renderFooter(w, opts);

  const markdown = `${w.lines.join("\n").trimEnd()}\n`;
  w.stats.messages = visible.length;
  w.stats.bytes = Buffer.byteLength(markdown, "utf8");
  return { markdown, stats: w.stats };
}

function renderMessage(w: Writer, message: ExportMessage, opts: ResolvedExportOptions): void {
  const heading = message.role === "user" ? "User" : "Assistant";
  const parts: string[] = [heading];
  if (message.isSidechain) parts.push("(subagent)");
  const time = clockTime(message.timestamp);
  if (time) parts.push(`· ${time}`);
  if (message.role === "assistant" && message.model) parts.push(`· ${message.model}`);

  const before = w.lines.length;
  const bodyStart = w.lines.length;
  w.push(`## ${parts.join(" ")}`);
  w.blank();

  for (const block of message.blocks) {
    renderBlock(w, block, opts);
  }

  // A message whose every block was filtered out (an assistant turn that
  // only made tool calls, under `minimal`) would otherwise leave a bare
  // heading. Drop the heading too rather than emit an empty section.
  if (w.lines.length === bodyStart + 2) {
    w.lines.length = before;
    return;
  }
  w.blank();
}

function renderBlock(w: Writer, block: ExportBlock, opts: ResolvedExportOptions): void {
  switch (block.kind) {
    case "text": {
      const text = (block.text ?? "").trim();
      if (!text) return;
      w.stats.blocks++;
      w.push(w.truncate(text, opts.maxTextChars));
      w.blank();
      return;
    }

    case "error": {
      const text = (block.text ?? "").trim() || "API error";
      w.stats.blocks++;
      w.push(`> [!CAUTION]`);
      w.push(`> **Error** — ${inlineCell(text, 400)}`);
      w.blank();
      return;
    }

    case "thinking": {
      const text = (block.text ?? "").trim();
      if (!text) return;
      if (!opts.thinking) {
        w.stats.blocksOmitted++;
        return;
      }
      w.stats.blocks++;
      // Collapsed: extended thinking is usually the single largest
      // contributor, and a reader wants it available, not in the way.
      w.push(`<details>`);
      w.push(`<summary>Thinking (${text.length.toLocaleString("en-US")} chars)</summary>`);
      w.blank();
      w.push(w.truncate(text, opts.maxTextChars));
      w.blank();
      w.push(`</details>`);
      w.blank();
      return;
    }

    case "tool_use": {
      if (!opts.toolCalls) {
        w.stats.blocksOmitted++;
        return;
      }
      w.stats.blocks++;
      const name = block.toolName || "tool";
      const gist = summarizeToolInput(block.input);
      w.push(gist ? `**\`${name}\`** — ${gist}` : `**\`${name}\`**`);
      w.blank();

      const cap = opts.maxToolChars;
      if (cap === 0 || !block.input || Object.keys(block.input).length === 0) return;
      const json = safeJson(block.input);
      // A one-argument call is fully described by the gist line above;
      // repeating it as JSON doubles the byte count for no information.
      if (isFullyDescribedBy(block.input, gist)) return;
      w.push(codeBlock(w.truncate(json, cap), "json"));
      w.blank();
      return;
    }

    case "tool_result": {
      const text = (block.text ?? "").trim();
      if (!text) return;
      if (!opts.toolResults || opts.maxToolChars === 0) {
        w.stats.blocksOmitted++;
        return;
      }
      w.stats.blocks++;
      const label = block.isError ? "Result (error)" : "Result";
      const name = block.toolName ? ` — \`${block.toolName}\`` : "";
      w.push(`<details>`);
      w.push(
        `<summary>${label}${name} (${text.length.toLocaleString("en-US")} chars)</summary>`,
      );
      w.blank();
      w.push(codeBlock(w.truncate(text, opts.maxToolChars)));
      w.blank();
      w.push(`</details>`);
      w.blank();
      return;
    }
  }
}

/** True when the gist line already contains everything the input holds. */
function isFullyDescribedBy(input: Record<string, unknown>, gist: string): boolean {
  const keys = Object.keys(input);
  if (keys.length !== 1 || !gist) return false;
  const only = input[keys[0]];
  return typeof only === "string" && !gist.endsWith("…") && only.replace(/\s+/g, " ").trim() === gist;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Circular or otherwise unserializable tool arguments must not take
    // the whole export down.
    return "[unserializable tool input]";
  }
}

function renderFooter(w: Writer, opts: ResolvedExportOptions): void {
  const notes: string[] = [];
  if (w.stats.blocksOmitted > 0) {
    notes.push(
      `${w.stats.blocksOmitted.toLocaleString("en-US")} block${w.stats.blocksOmitted === 1 ? "" : "s"} omitted by the \`${opts.detail}\` detail level`,
    );
  }
  if (w.stats.sidechainsSkipped > 0) {
    notes.push(
      `${w.stats.sidechainsSkipped.toLocaleString("en-US")} subagent message${w.stats.sidechainsSkipped === 1 ? "" : "s"} excluded`,
    );
  }
  if (w.stats.blocksTruncated > 0) {
    notes.push(
      `${w.stats.blocksTruncated.toLocaleString("en-US")} block${w.stats.blocksTruncated === 1 ? "" : "s"} truncated (${w.stats.charsTruncated.toLocaleString("en-US")} characters)`,
    );
  }
  if (notes.length === 0) return;

  w.push("---");
  w.blank();
  w.push(`_Export notes: ${notes.join("; ")}._`);
}
