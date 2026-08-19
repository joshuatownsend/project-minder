// Shared continuation-merge state for the file-parse assistant loops.
//
// Claude Code writes **one JSONL line per content block**: a message that
// thought, spoke, and then called two tools is four lines sharing one
// `message.id`, each repeating the message-level `usage` verbatim.
//
// Deduping by `message.id` is right for TOKENS — a genuine re-log (retry, or a
// resumed-session re-emit) would otherwise double-count cost. It was wrong for
// everything else: the old code `continue`d on the repeat and discarded the
// whole line, taking its `tool_use` blocks with it. Measured on one project,
// write-class edits only: 4,164 blocks in the raw JSONL, 4,164 in the SQLite
// index, **1,651** on the file path — 40% of the truth (#453).
//
// `db/ingest.ts` already resolved this (#426): keep the `message.id` guard for
// usage, and move content dedupe down to block level so a real re-log still
// cannot double-count. This module is that same split for the file path, in one
// place, because `parser.ts` runs two near-identical loops (`parseSessionTurns`
// and `parseSessionTurnsWithMeta`) and a fix applied to one of them would drift
// from the other — the exact failure mode that left this bug live after #426.

import type { ToolCall } from "./types";
import { categorizeToolError } from "./toolErrorCategorizer";

/** `tool_use_id` -> the `tool_result` that reported on it. */
export type ToolErrorLookup = Map<string, { isError: boolean; content: string }>;

/**
 * Per-message state carried across every line that shares one `message.id`.
 *
 * Keyed on the id rather than "the previous turn": continuation lines are
 * usually adjacent but not reliably so — ingest measured 6 to 87 detached
 * continuations per session, one separated from its first line by 3,639 lines.
 */
export interface OpenAssistantMessage {
  /** Index into the caller's `turns` array of the row these blocks belong to. */
  turnIndex: number;
  /** Every distinct text block so far, joined with a newline — re-sliced on merge. */
  text: string;
  /** `tool_use_id`s already recorded, so an exact re-log is still dropped. */
  toolUseIds: Set<string>;
  /** Text bodies already recorded, same purpose for prose. */
  textKeys: Set<string>;
  /**
   * The slash-command window in force when this message STARTED.
   *
   * Latched, not read live at merge time. A continuation can arrive after later
   * user turns — the whole reason this is keyed on `message.id` — and reading
   * the live cursor would file a `Skill` call split onto a continuation line as
   * `auto`, or worse, attribute it to an unrelated later slash command. Same
   * defect Codex and Copilot caught on the ingest path in PR #427.
   */
  slashCmds: Set<string> | undefined;
  /**
   * Whether this message already claimed the pending slash-command window.
   * Per MESSAGE, not per line: one message is one turn, and a tool split across
   * two lines must not consume the window twice.
   */
  slashConsumed: boolean;
}

/**
 * Convert `tool_use` blocks into `ToolCall`s.
 *
 * Shared by a message's first line and every continuation line so the two
 * cannot drift — the continuation path is not a reduced copy that forgets to
 * resolve tool errors or match the slash-command window.
 */
export function buildToolCalls(
  blocks: Array<{ id?: string; name?: string; input?: Record<string, any> }>,
  errorByToolUseId: ToolErrorLookup,
  open: Pick<OpenAssistantMessage, "slashCmds" | "slashConsumed">
): ToolCall[] {
  return blocks.map((b): ToolCall => {
    const id: string | undefined = b.id;
    const errEntry = id ? errorByToolUseId.get(id) : undefined;
    const isError = errEntry?.isError ?? false;
    const errorCategory = isError ? categorizeToolError(errEntry?.content ?? "") : undefined;
    const skillName =
      b.name === "Skill" && typeof b.input?.skill === "string" ? b.input.skill : undefined;
    const isSlashMatch =
      !open.slashConsumed && !!open.slashCmds && !!skillName && open.slashCmds.has(skillName);
    if (isSlashMatch) open.slashConsumed = true;
    return {
      // `ToolCall.name` is required, and the cast this replaced would have put a
      // literal `undefined` there for a `tool_use` block with no `name` —
      // producing an "undefined" bucket in `topTools` and in every downstream
      // grouping. `ingest.ts:583` already normalizes the same case to "unknown",
      // so matching it keeps the two backends agreeing rather than inventing a
      // third answer. (Copilot, PR #468.)
      name: typeof b.name === "string" ? b.name : "unknown",
      id,
      arguments: b.input,
      isError: isError || undefined,
      errorCategory,
      invocationSource: isSlashMatch ? "slash_command" : "auto",
    };
  });
}

/** Open a message's state from its FIRST line, seeding the block-level guards. */
export function openAssistantMessage(
  turnIndex: number,
  content: any[],
  slashCmds: Set<string> | undefined
): OpenAssistantMessage {
  const open: OpenAssistantMessage = {
    turnIndex,
    text: "",
    toolUseIds: new Set<string>(),
    textKeys: new Set<string>(),
    slashCmds,
    slashConsumed: false,
  };
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string" && b.text) {
      open.textKeys.add(b.text);
      open.text = open.text ? `${open.text}\n${b.text}` : b.text;
    } else if (b?.type === "tool_use" && typeof b.id === "string") {
      open.toolUseIds.add(b.id);
    }
  }
  return open;
}

/**
 * Fold a continuation line's blocks into the message already open for that id.
 *
 * Returns only what changed. Nothing here touches tokens — the first line
 * already accounted for the whole message's `usage`, which is the one part of
 * the old `message.id` guard that was always correct.
 */
export function mergeAssistantContinuation(
  open: OpenAssistantMessage,
  content: unknown,
  errorByToolUseId: ToolErrorLookup
): { toolCalls: ToolCall[]; text: string | null } {
  if (!Array.isArray(content)) return { toolCalls: [], text: null };

  const newTools: Array<{ id?: string; name?: string; input?: Record<string, any> }> = [];
  let textChanged = false;

  for (const b of content as any[]) {
    if (b?.type === "text" && typeof b.text === "string" && b.text) {
      if (open.textKeys.has(b.text)) continue;
      open.textKeys.add(b.text);
      open.text = open.text ? `${open.text}\n${b.text}` : b.text;
      textChanged = true;
    } else if (b?.type === "tool_use") {
      // The re-log this guard was written for repeats its `tool_use_id`. This
      // is where its real job survives the union.
      const id = typeof b.id === "string" ? b.id : null;
      if (id) {
        if (open.toolUseIds.has(id)) continue;
        open.toolUseIds.add(id);
      }
      newTools.push(b);
    }
  }

  return {
    toolCalls: newTools.length > 0 ? buildToolCalls(newTools, errorByToolUseId, open) : [],
    // Re-derive rather than append: the caller caps `assistantText`, and a
    // truncation cannot be extended by concatenation once applied.
    text: textChanged ? open.text : null,
  };
}
