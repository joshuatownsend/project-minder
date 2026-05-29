/**
 * Hook payload parser (T2.3a) — turns the raw JSON body Claude Code POSTs
 * to `/api/hooks` into a typed discriminated union keyed on
 * `hook_event_name`. Pure / data-in-data-out so it's trivially testable
 * and never throws; returns `null` on shape mismatch (the route logs and
 * keeps the envelope-level event).
 *
 * Scope: the 9 hook events the project already enumerates in
 * `HookEventName` (PreToolUse, PostToolUse, UserPromptSubmit,
 * Notification, Stop, SubagentStop, PreCompact, SessionStart, SessionEnd).
 * Claude Code v2.1.145 added `background_tasks` and `session_crons`
 * arrays to Stop / SubagentStop — captured here as `unknown[]` because
 * the public hooks doc doesn't yet publish the inner shape (we'll tighten
 * once it surfaces).
 *
 * Common envelope (per the hooks doc): `session_id`, `transcript_path`,
 * `cwd`, `permission_mode`, `hook_event_name`. Only the event-specific
 * additions live on each variant — `sessionId` / `cwd` are already in
 * the parent `HookEvent`.
 */

import type { HookEventName } from "../types";
import { str, bool, num, arr } from "../coerce";

export interface BasePayload {
  /** Path to the JSONL transcript on disk — common to every event. */
  transcriptPath?: string;
  /** `default`, `acceptEdits`, `plan`, `bypassPermissions` — common across events. */
  permissionMode?: string;
}

export interface PreToolUsePayload extends BasePayload {
  kind: "PreToolUse";
  toolName: string;
  /** Tool-specific input shape; preserved verbatim. */
  toolInput?: unknown;
  toolUseId?: string;
}

export interface PostToolUsePayload extends BasePayload {
  kind: "PostToolUse";
  toolName: string;
  toolInput?: unknown;
  /** Tool-specific result shape; preserved verbatim. The route's
   *  `toolFailed` discrimination still runs against this in route.ts. */
  toolResponse?: unknown;
  toolUseId?: string;
  durationMs?: number;
}

export interface UserPromptSubmitPayload extends BasePayload {
  kind: "UserPromptSubmit";
  prompt: string;
}

export interface NotificationPayload extends BasePayload {
  kind: "Notification";
  /** `permission_prompt`, `idle_prompt`, `auth_success`, etc. */
  matcher?: string;
  message?: string;
}

/**
 * Stop / SubagentStop carry the new v2.1.145 `background_tasks` +
 * `session_crons` arrays. Inner shapes captured as `unknown[]` since the
 * public docs don't yet publish field names — runtime UI surfaces use
 * defensive narrowing (`typeof`, `'field' in obj`) on each element.
 */
export interface StopPayload extends BasePayload {
  kind: "Stop";
  stopHookActive?: boolean;
  backgroundTasks?: unknown[];
  sessionCrons?: unknown[];
}

export interface SubagentStopPayload extends BasePayload {
  kind: "SubagentStop";
  stopHookActive?: boolean;
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
  lastAssistantMessage?: string;
  /** SubagentStop also receives the parent session's bg-tasks / crons. */
  backgroundTasks?: unknown[];
  sessionCrons?: unknown[];
}

export interface PreCompactPayload extends BasePayload {
  kind: "PreCompact";
  /** `manual` for `/compact`, `auto` for context-window-full auto-compact. */
  trigger?: "manual" | "auto";
  customInstructions?: string;
}

export interface SessionStartPayload extends BasePayload {
  kind: "SessionStart";
  /** `startup` / `resume` / `clear` / `compact` per the matcher table. */
  source?: string;
  model?: string;
  agentType?: string;
}

export interface SessionEndPayload extends BasePayload {
  kind: "SessionEnd";
  /** `clear` / `resume` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other`. */
  reason?: string;
}

export type HookPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | UserPromptSubmitPayload
  | NotificationPayload
  | StopPayload
  | SubagentStopPayload
  | PreCompactPayload
  | SessionStartPayload
  | SessionEndPayload;

// Field-extraction helpers (`str`/`bool`/`num`/`arr`) live in `@/lib/coerce` —
// they return `undefined` (not throw) on type mismatch so a single bad field
// doesn't poison the whole parse, matching the route's "best-effort capture"
// posture.

function commonBase(body: Record<string, unknown>): BasePayload {
  return {
    transcriptPath: str(body.transcript_path),
    permissionMode: str(body.permission_mode),
  };
}

/**
 * Parse the raw body into a typed payload keyed on `eventName`. Returns
 * `null` when the body is missing fields the variant declares as
 * required (e.g. PreToolUse without `tool_name`). Optional fields just
 * fall through as `undefined`.
 */
export function parseHookPayload(
  body: Record<string, unknown>,
  eventName: HookEventName,
): HookPayload | null {
  const base = commonBase(body);

  switch (eventName) {
    case "PreToolUse": {
      const toolName = str(body.tool_name);
      if (!toolName) return null;
      return {
        kind: "PreToolUse",
        ...base,
        toolName,
        toolInput: body.tool_input,
        toolUseId: str(body.tool_use_id),
      };
    }

    case "PostToolUse": {
      const toolName = str(body.tool_name);
      if (!toolName) return null;
      return {
        kind: "PostToolUse",
        ...base,
        toolName,
        toolInput: body.tool_input,
        toolResponse: body.tool_response,
        toolUseId: str(body.tool_use_id),
        durationMs: num(body.duration_ms),
      };
    }

    case "UserPromptSubmit": {
      const prompt = str(body.prompt);
      if (prompt === undefined) return null;
      return { kind: "UserPromptSubmit", ...base, prompt };
    }

    case "Notification":
      return {
        kind: "Notification",
        ...base,
        matcher: str(body.matcher) ?? str(body.notification_type),
        message: str(body.message),
      };

    case "Stop":
      return {
        kind: "Stop",
        ...base,
        stopHookActive: bool(body.stop_hook_active),
        backgroundTasks: arr(body.background_tasks),
        sessionCrons: arr(body.session_crons),
      };

    case "SubagentStop":
      return {
        kind: "SubagentStop",
        ...base,
        stopHookActive: bool(body.stop_hook_active),
        agentId: str(body.agent_id),
        agentType: str(body.agent_type),
        agentTranscriptPath: str(body.agent_transcript_path),
        lastAssistantMessage: str(body.last_assistant_message),
        backgroundTasks: arr(body.background_tasks),
        sessionCrons: arr(body.session_crons),
      };

    case "PreCompact": {
      const trigger = str(body.trigger);
      return {
        kind: "PreCompact",
        ...base,
        trigger:
          trigger === "manual" || trigger === "auto" ? trigger : undefined,
        customInstructions: str(body.custom_instructions),
      };
    }

    case "SessionStart":
      return {
        kind: "SessionStart",
        ...base,
        source: str(body.source),
        model: str(body.model),
        agentType: str(body.agent_type),
      };

    case "SessionEnd":
      return {
        kind: "SessionEnd",
        ...base,
        reason: str(body.reason),
      };
  }
}
