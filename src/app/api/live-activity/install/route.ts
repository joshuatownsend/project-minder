import { NextRequest, NextResponse } from "next/server";
import { mutateConfig } from "@/lib/config";
import {
  installLiveActivityHooks,
  removeLiveActivityHooks,
  getLiveActivityHookStatus,
} from "@/lib/hooks/applyLiveActivity";

/** GET /api/live-activity/install — return current install status. */
export async function GET(): Promise<NextResponse> {
  const status = await getLiveActivityHookStatus();
  return NextResponse.json(status);
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

  // Validate hookUrl: must be http://localhost, http://127.0.0.1, or https:
  try {
    const u = new URL(hookUrl);
    const isLocalhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalhost)) {
      return NextResponse.json(
        { error: "hookUrl must be an HTTPS URL or http://localhost / http://127.0.0.1" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: "hookUrl is not a valid URL" }, { status: 400 });
  }

  try {
    await installLiveActivityHooks(hookUrl);
    // Persist hookUrl to MinderConfig so Settings UI can display it
    await mutateConfig((c) => {
      c.liveActivity = { ...(c.liveActivity ?? {}), hookUrl };
    });
    const status = await getLiveActivityHookStatus();
    return NextResponse.json({ ok: true, ...status });
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
    const status = await getLiveActivityHookStatus();
    return NextResponse.json({ ok: true, ...status });
  } catch (err) {
    console.error("[live-activity] remove failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "remove failed" },
      { status: 500 },
    );
  }
}
