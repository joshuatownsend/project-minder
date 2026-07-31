import { NextRequest, NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getCachedScan } from "@/lib/cache";
import { resolveProjectSlug } from "@/lib/hooks/resolveProjectSlug";
import {
  pushHookEvent,
  updateLiveSession,
  clearLiveSession,
  setAwaiting,
  clearAwaiting,
  STOP_EVENTS,
} from "@/lib/hooks/buffer";
import { parseHookPayload } from "@/lib/hooks/payload";
import { dispatchAwaitingPermission } from "@/lib/notifications/dispatchAwaitingPermission";
import { evaluateAndDispatchRules } from "@/lib/notifications/rules/engine";
import { SENTINEL_UA } from "@/lib/hooks/curlCommand";
import { bridgeHookToEventBus } from "@/lib/agentView/eventBus";
import type { HookEventName } from "@/lib/types";

const VALID_EVENTS = new Set<string>([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Check feature flag before parsing the body
  let config;
  try {
    config = await readConfig();
  } catch {
    return NextResponse.json({ ok: false, error: "config unavailable" }, { status: 503 });
  }

  const flagEnabled = getFlag(config.featureFlags, "liveActivity", false);
  if (!flagEnabled) {
    return NextResponse.json({ ok: true, ignored: "flag-off" });
  }

  if (request.headers.get("user-agent") !== SENTINEL_UA) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { session_id, cwd, hook_event_name } = body;

  if (typeof session_id !== "string" || !session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }
  if (typeof cwd !== "string" || !cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  if (typeof hook_event_name !== "string" || !VALID_EVENTS.has(hook_event_name)) {
    return NextResponse.json({ error: "invalid hook_event_name" }, { status: 400 });
  }

  const eventName = hook_event_name as HookEventName;
  const slug = resolveProjectSlug(cwd);

  // Normalize failure signal from PostToolUse payloads.
  // Canonical: is_error (Anthropic tool_result flag). Bash-specific: non-zero return_code.
  let toolFailed: boolean | undefined;
  if (eventName === "PostToolUse") {
    const resp = body.tool_response as Record<string, unknown> | undefined;
    const isError = resp?.is_error === true;
    const badReturnCode =
      typeof resp?.return_code === "number" && resp.return_code !== 0;
    toolFailed = isError || badReturnCode || undefined;
  }

  // T2.3a: typed payload parse alongside the existing envelope capture.
  // `parseHookPayload` returns `null` on shape mismatch — the envelope
  // event still goes into the ring buffer either way.
  const payload = parseHookPayload(body, eventName);

  const event = {
    hookEventName: eventName,
    sessionId: session_id,
    cwd,
    receivedAt: Date.now(),
    toolName: typeof body.tool_name === "string" ? body.tool_name : undefined,
    message: typeof body.message === "string" ? body.message : undefined,
    toolFailed,
    payload,
  };

  pushHookEvent(slug, event);
  bridgeHookToEventBus(slug, session_id, eventName, event.toolName, event.message);

  const projectName = getCachedScan()?.projects.find((p) => p.slug === slug)?.name ?? slug;

  // Notification rules run against *every* event, not just Notification ones —
  // that is the whole point of the engine (a .env read arrives as PreToolUse).
  // Fire-and-forget: the Claude Code process is blocked on this response, and
  // push/telegram delivery crosses the network.
  evaluateAndDispatchRules(config, event, slug, projectName).catch((err: unknown) => {
    console.warn("[hooks] rule dispatch failed:", err);
  });

  if (STOP_EVENTS.has(eventName)) {
    clearLiveSession(session_id);
  } else {
    updateLiveSession(session_id, slug, eventName);

    if (eventName === "Notification") {
      const isNew = setAwaiting(slug);
      if (isNew) {
        // Fire and forget — don't block the hook response
        dispatchAwaitingPermission({
          slug,
          projectName,
          message: event.message,
        }).catch((err: unknown) => {
          console.warn("[hooks] dispatch failed:", err);
        });
      }
    } else {
      // Any non-Notification event clears the awaiting state (user responded)
      clearAwaiting(slug);
    }
  }

  return NextResponse.json({ ok: true, slug });
}
