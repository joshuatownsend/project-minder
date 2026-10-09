import { NextRequest, NextResponse } from "next/server";
import { readConfig, mutateConfig } from "@/lib/config";
import {
  installLiveActivityHooks,
  removeLiveActivityHooks,
  getLiveActivityHookStatus,
} from "@/lib/hooks/applyLiveActivity";
import { getLastHookReceivedAt } from "@/lib/hooks/buffer";
import { safeHookUrl } from "@/lib/hooks/curlCommand";

/** GET /api/live-activity/install — return current install status including registered hookUrl. */
export async function GET(): Promise<NextResponse> {
  const [status, config] = await Promise.all([getLiveActivityHookStatus(), readConfig()]);
  return NextResponse.json({
    ...status,
    hookUrl: config.liveActivity?.hookUrl ?? null,
    lastReceivedAt: getLastHookReceivedAt(),
  });
}

/** POST /api/live-activity/install — install hooks into ~/.claude/settings.json. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const hookUrl = (body as Record<string, unknown>)?.hookUrl;
  if (typeof hookUrl !== "string" || !hookUrl) {
    return NextResponse.json({ error: "hookUrl required" }, { status: 400 });
  }

  // Validate hookUrl: a plain http(s) URL to loopback only. It ends up inside a shell command in the
  // user's Claude settings, so the NORMALIZED url is what gets installed and persisted (#631).
  const safeUrl = safeHookUrl(hookUrl);
  if (!safeUrl) {
    return NextResponse.json(
      { error: "hookUrl must be a plain http(s) URL to localhost, 127.0.0.1 or [::1] (no query, credentials or special characters)" },
      { status: 400 },
    );
  }

  try {
    await installLiveActivityHooks(safeUrl);
    // Persist hookUrl to MinderConfig so Settings UI can display it
    await mutateConfig((c) => {
      c.liveActivity = { ...(c.liveActivity ?? {}), hookUrl: safeUrl };
    });
    const status = await getLiveActivityHookStatus();
    return NextResponse.json({ ok: true, ...status, hookUrl, lastReceivedAt: getLastHookReceivedAt() });
  } catch (err) {
    console.error("[live-activity] install failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "install failed" },
      { status: 500 },
    );
  }
}

/** DELETE /api/live-activity/install — remove all managed hook entries. */
export async function DELETE(): Promise<NextResponse> {
  try {
    await removeLiveActivityHooks();
    await mutateConfig((c) => {
      if (c.liveActivity) delete c.liveActivity.hookUrl;
    });
    const status = await getLiveActivityHookStatus();
    return NextResponse.json({ ok: true, ...status, hookUrl: null, lastReceivedAt: getLastHookReceivedAt() });
  } catch (err) {
    console.error("[live-activity] remove failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "remove failed" },
      { status: 500 },
    );
  }
}
