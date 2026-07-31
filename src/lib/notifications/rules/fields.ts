/**
 * Notification rules engine — field extraction.
 *
 * Flattens a `HookEvent` into the curated `RuleField` namespace the matcher
 * works against. Pure and total: never throws, returns `undefined` for fields
 * the event doesn't carry (an absent field never matches).
 */

import type { HookEvent } from "@/lib/hooks/buffer";
import {
  MAX_ANY_LENGTH,
  MAX_FIELD_LENGTH,
  type RuleField,
} from "./types";

/**
 * Per-leaf cap applied *before* joining a tool-input/response object.
 *
 * Why per-leaf and not just a cap on the joined string: `Edit` inputs put a
 * multi-kilobyte `new_string` next to the `file_path` that actually matters,
 * and `Read`/`Bash` responses can be enormous. Capping only the total would
 * let one giant leaf push every other field past the truncation point — so a
 * `.env` rule would match a small edit and silently miss a large one. Capping
 * each leaf keeps every key represented regardless of its neighbours' size.
 */
const MAX_LEAF_LENGTH = 512;

/**
 * Depth 4 is what MultiEdit needs: the input object (0) holds an `edits` array
 * (1) of edit objects (2) whose string values sit at (3). The check below runs
 * *before* descending, so a limit of 3 would stop at the edit object and drop
 * every `old_string` — i.e. a rule would silently miss a MultiEdit touching a
 * secret. Total work is bounded by the leaf-count cap, not by depth.
 */
const MAX_DEPTH = 4;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Collect the scalar leaves of an arbitrary tool input/response into a single
 * searchable string. Keys are included too, so a rule can match on a field
 * name (e.g. `contains "file_path"`) and not just its value.
 */
function flattenLeaves(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length > 200) return out; // hard stop on pathological structures
  if (value === null || value === undefined) return out;

  if (typeof value === "string") {
    out.push(truncate(value, MAX_LEAF_LENGTH));
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (depth >= MAX_DEPTH) return out;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) flattenLeaves(item, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      flattenLeaves(v, depth + 1, out);
    }
  }
  return out;
}

function stringifyToolField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const leaves = flattenLeaves(value);
  if (leaves.length === 0) return undefined;
  return truncate(leaves.join(" "), MAX_FIELD_LENGTH);
}

/** Field values are `string | number` — booleans render as "true"/"false" so
 *  `tool.failed equals true` reads naturally in the editor. */
export type FieldValues = Partial<Record<RuleField, string | number>>;

/**
 * Build the field map for one hook event.
 *
 * `projectSlug` is passed in rather than re-derived because the route has
 * already resolved it (see `resolveProjectSlug`) and the two must agree — the
 * slug is what a notification's deep link uses.
 */
export function extractFields(event: HookEvent, projectSlug: string): FieldValues {
  const p = event.payload ?? undefined;

  const fields: FieldValues = {
    event: event.hookEventName,
    project: projectSlug,
    cwd: truncate(event.cwd, MAX_FIELD_LENGTH),
  };

  if (p?.permissionMode) fields.permissionMode = p.permissionMode;
  if (event.toolName) fields["tool.name"] = event.toolName;
  if (event.toolFailed !== undefined) fields["tool.failed"] = String(event.toolFailed);
  if (event.message) fields.message = truncate(event.message, MAX_FIELD_LENGTH);

  if (p) {
    switch (p.kind) {
      case "PreToolUse": {
        const input = stringifyToolField(p.toolInput);
        if (input) fields["tool.input"] = input;
        break;
      }
      case "PostToolUse": {
        const input = stringifyToolField(p.toolInput);
        if (input) fields["tool.input"] = input;
        const response = stringifyToolField(p.toolResponse);
        if (response) fields["tool.response"] = response;
        if (p.durationMs !== undefined) fields["tool.durationMs"] = p.durationMs;
        break;
      }
      case "UserPromptSubmit":
        fields.prompt = truncate(p.prompt, MAX_FIELD_LENGTH);
        break;
      case "Notification":
        if (p.message) fields.message = truncate(p.message, MAX_FIELD_LENGTH);
        break;
      case "SessionStart":
        if (p.model) fields.model = p.model;
        break;
      case "SubagentStop":
        if (p.agentType) fields.agentType = p.agentType;
        if (p.lastAssistantMessage) {
          fields.message = truncate(p.lastAssistantMessage, MAX_FIELD_LENGTH);
        }
        break;
      default:
        break;
    }
  }

  // `any` is derived last so it sees every field resolved above. Numeric
  // fields are included as text so a regex over "any" can still see them.
  const anyParts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "project" || key === "event") continue; // low-signal, always present
    if (value !== undefined) anyParts.push(String(value));
  }
  if (anyParts.length > 0) fields.any = truncate(anyParts.join(" "), MAX_ANY_LENGTH);

  return fields;
}
