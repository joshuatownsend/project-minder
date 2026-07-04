// Leaf tool-call / text parsing helpers extracted verbatim from `ingest.ts`.
// These are pure, module-state-free utilities shared by the reconcile and
// adapter paths — behavior is identical to their previous in-file form.

import { createReadStream } from "fs";
import {
  FILE_OP_BY_TOOL,
  AGENT_DISPATCH_TOOL,
  SKILL_DISPATCH_TOOL,
  type FileOp,
} from "@/lib/usage/toolNames";

// ── Tool-call classification helpers ───────────────────────────────────────

/**
 * Map a tool call to a (file_path, file_op) pair when both can be derived.
 * `file_path` is the canonical Claude Code argument key for path-shaped
 * tools — Read, Write, Edit, MultiEdit. Returns null/null for non-file
 * tools or when the path is missing.
 */
export function extractFileOp(
  toolName: string,
  args: Record<string, unknown> | undefined
): { filePath: string | null; fileOp: FileOp | null } {
  if (!args) return { filePath: null, fileOp: null };
  const fp = typeof args.file_path === "string" ? args.file_path : null;
  if (!fp) return { filePath: null, fileOp: null };
  return { filePath: fp, fileOp: FILE_OP_BY_TOOL[toolName] ?? null };
}

/** `Agent` tool args carry `subagent_type` per Claude Code's JSONL convention. */
export function extractAgentName(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (toolName !== AGENT_DISPATCH_TOOL || !args) return null;
  return typeof args.subagent_type === "string" ? args.subagent_type : null;
}

/** `Skill` tool args carry `skill` per Claude Code's JSONL convention. */
export function extractSkillName(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (toolName !== SKILL_DISPATCH_TOOL || !args) return null;
  return typeof args.skill === "string" ? args.skill : null;
}

// ── JSONL → ParsedSession ──────────────────────────────────────────────────

export function truncateText(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Read [start, EOF) of a file and return the bytes up to the LAST `\n`
 * along with the byte position immediately after it. Anything after the
 * last newline is treated as a partial line that hasn't been flushed yet
 * and must NOT advance the cursor — otherwise a writer mid-flush could
 * cause us to skip a turn permanently when its first half lands before
 * a reconcile and the second half lands after.
 *
 * Returns `{ text: "", safeOffset: start }` when there's no `\n` in the
 * tail (purely partial content).
 *
 * Backed by `createReadStream({ start })` so the OS only delivers bytes
 * after `start`. The byte-vs-char distinction matters because we can't
 * use `String.lastIndexOf("\n")` here — we need the BYTE position to
 * compute a correct cursor on multi-byte UTF-8 content.
 */
export async function readTailToLastNewline(
  filePath: string,
  start: number
): Promise<{ text: string; safeOffset: number }> {
  const stream = createReadStream(filePath, { start });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  // Walk backwards looking for the last 0x0A. lastIndexOf on a Buffer is
  // a single byte scan; cheaper than the BoyerMoore lookup ChainExt'd
  // strings would do.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return { text: "", safeOffset: start };
  }
  const text = buf.subarray(0, lastNewline + 1).toString("utf8");
  return { text, safeOffset: start + lastNewline + 1 };
}
