// Shared helpers for walking Claude Code's JSONL `content` arrays.
//
// JSONL turn entries carry `message.content` (assistant) or `content` /
// `message.content` (user) as an array of typed blocks: `{ type: "text",
// text }`, `{ type: "tool_use", name, input }`, `{ type: "tool_result",
// content }`. The legacy file-parse path in `parser.ts` and the new
// SQLite ingest path in `db/ingest.ts` both walk these blocks; this
// module is the one home for that walk so the two paths can't drift.

/** First-pass content shape: untyped because real JSONL frequently has
 *  vendor-specific extensions we don't model. Callers narrow as needed. */
export type ContentBlock = {
  type?: string;
  text?: string;
  content?: unknown;
};

export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let acc = "";
  for (const b of content as ContentBlock[]) {
    if (b?.type === "text" && typeof b.text === "string") {
      if (acc) acc += "\n";
      acc += b.text;
    }
  }
  return acc;
}

export function extractToolResults(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let acc = "";
  for (const b of content as ContentBlock[]) {
    if (b?.type !== "tool_result") continue;
    let chunk = "";
    if (typeof b.content === "string") {
      chunk = b.content;
    } else if (Array.isArray(b.content)) {
      for (const c of b.content as ContentBlock[]) {
        if (c?.type === "text" && typeof c.text === "string") {
          if (chunk) chunk += "\n";
          chunk += c.text;
        }
      }
    }
    if (!chunk) continue;
    if (acc) acc += "\n";
    acc += chunk;
  }
  return acc;
}

/**
 * Heuristic: a user message starting with `<` is a system-injected hook
 * payload (e.g. `<user-prompt-submit-hook>`, `<command-name>`) rather
 * than a human-typed prompt. Used to find the "real" first/last user
 * prompts of a session.
 */
export function isHumanText(text: string | undefined | null): boolean {
  if (!text) return false;
  return !text.trim().startsWith("<");
}

/** Filter `content` to `tool_use` blocks. Used for one-pass walks. */
export function toolUseBlocks(content: unknown): Array<{
  id?: string;
  name?: string;
  input?: unknown;
}> {
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).filter(
    (b): b is ContentBlock & { name?: string; id?: string; input?: unknown } =>
      b?.type === "tool_use"
  );
}
