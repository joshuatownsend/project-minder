import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getCachedScan } from "@/lib/cache";
import { toSlug } from "@/lib/scanner/index";
import {
  pushHookEvent,
  updateLiveSession,
  clearLiveSession,
  setAwaiting,
  clearAwaiting,
  STOP_EVENTS,
} from "@/lib/hooks/buffer";
import { dispatchAwaitingPermission } from "@/lib/notifications/dispatchAwaitingPermission";
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

/** Resolve a cwd path to a project slug using the live scan cache. */
function resolveSlug(cwd: string): string {
  const resolved = path.resolve(cwd);
  const scan = getCachedScan();
  if (scan) {
    for (const p of scan.projects) {
      if (!p.path) continue;
      const projectResolved = path.resolve(p.path);
      // Exact match or cwd is a subdirectory of the project
      if (
        resolved === projectResolved ||
        (resolved.startsWith(projectResolved + path.sep) &&
          !path.relative(projectResolved, resolved).startsWith(".."))
      ) {
        return p.slug;
      }
    }
  }
  // Fallback: derive slug from the directory basename (may not match exactly)
  return toSlug(path.basename(resolved)) || "__unknown__";
}

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
  const slug = resolveSlug(cwd);

  const event = {
    hookEventName: eventName,
    sessionId: session_id,
    cwd,
    receivedAt: Date.now(),
    toolName: typeof body.tool_name === "string" ? body.tool_name : undefined,
    message: typeof body.message === "string" ? body.message : undefined,
  };

  pushHookEvent(slug, event);
  bridgeHookToEventBus(slug, session_id, eventName, event.toolName, event.message);

  if (STOP_EVENTS.has(eventName)) {
    clearLiveSession(session_id);
  } else {
    updateLiveSession(session_id, slug, eventName);

    if (eventName === "Notification") {
      const isNew = setAwaiting(slug);
      if (isNew) {
        // Find project name for the notification payload
        const scan = getCachedScan();
        const projectName =
          scan?.projects.find((p) => p.slug === slug)?.name ?? slug;
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
