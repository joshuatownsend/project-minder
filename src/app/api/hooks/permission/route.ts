import { NextRequest, NextResponse } from "next/server";
import {
  requestApproval,
  clampApprovalTimeout,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalRequestInput,
} from "@/lib/approvals/store";
import { buildHookOutput, failOpenHookOutput } from "@/lib/approvals/hookResponse";
import { summarizeToolCall } from "@/lib/approvals/summarize";
import { getFlag } from "@/lib/featureFlags";
import { readConfig } from "@/lib/config";
import { dispatchAwaitingPermission } from "@/lib/notifications/dispatchAwaitingPermission";
import { resolveProjectSlug, UNKNOWN_PROJECT_SLUG } from "@/lib/hooks/resolveProjectSlug";
import { getCachedScan } from "@/lib/cache";
import { SENTINEL_UA_APPROVAL } from "@/lib/hooks/curlCommand";

// `POST /api/hooks/permission` — the BLOCKING half of the hook surface.
//
// `/api/hooks` records lifecycle events and returns immediately. This
// route deliberately does the opposite: it holds the request open until a
// human decides or the deadline passes, because Claude Code's
// `PreToolUse` hook is synchronous and reads its decision from the hook
// process's stdout.
//
// **Every path returns 200 with a valid hook payload.** Not 4xx, not 5xx,
// not an empty body. The hook's stdout is parsed by Claude Code, and the
// only safe failure mode is `permissionDecision: "ask"`, which restores
// the normal terminal prompt. A 500 here would leave the user staring at
// a stalled tool call — the tool that watches your session must never be
// able to wedge it. That is why the whole body sits inside one try/catch
// whose handler still returns a usable decision.
//
// Response caching would be catastrophic for a decision endpoint, so the
// route is explicitly dynamic.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    // Default-OFF via `getFlag`'s third argument. A gate that switched itself
    // on at install would start blocking tool calls unasked.
    const config = await readConfig().catch(() => undefined);
    if (!getFlag(config?.featureFlags, "blockingApprovals", false)) {
      return NextResponse.json(
        failOpenHookOutput("Project Minder approval gate is disabled")
      );
    }

    // Origin check, mirroring `/api/hooks`. Unlike that route this answers
    // 200-with-`ask` rather than 403: the invariant above says every response
    // is a valid hook payload, and a stray caller must not be able to create
    // a pending entry (each one holds a timer and a notification).
    if (request.headers.get("user-agent") !== SENTINEL_UA_APPROVAL) {
      return NextResponse.json(failOpenHookOutput("Unrecognized hook caller"));
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(failOpenHookOutput("Unreadable hook payload"));
    }

    const toolName =
      typeof payload.tool_name === "string"
        ? payload.tool_name
        : typeof payload.toolName === "string"
          ? payload.toolName
          : null;
    if (!toolName) {
      // Without a tool name there is nothing to describe to the user, so
      // there is nothing meaningful to approve. Fail open.
      return NextResponse.json(failOpenHookOutput("Hook payload carried no tool name"));
    }

    const rawInput =
      (payload.tool_input as unknown) ?? (payload.toolInput as unknown) ?? {};
    const sessionId =
      typeof payload.session_id === "string"
        ? payload.session_id
        : typeof payload.sessionId === "string"
          ? payload.sessionId
          : null;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : null;

    // Bounds live in the store, next to the `setTimeout` they constrain, so
    // no call path can hand it an unbounded deadline. See
    // `clampApprovalTimeout`.
    const timeoutMs = clampApprovalTimeout(
      payload.timeout_ms ?? DEFAULT_APPROVAL_TIMEOUT_MS
    );

    // A session id is NOT a project slug. `dispatchAwaitingPermission` builds
    // its deep link as `/project/${slug}`, so passing the session id through
    // produced a notification that opened a route which does not exist.
    const projectSlug = cwd ? resolveProjectSlug(cwd) : null;
    const projectName =
      (projectSlug
        ? getCachedScan()?.projects.find((p) => p.slug === projectSlug)?.name
        : undefined) ??
      projectSlug ??
      "project";

    const input: ApprovalRequestInput = {
      sessionId,
      toolName,
      summary: summarizeToolCall(toolName, rawInput),
      projectSlug,
      cwd,
    };

    const { id, outcome } = requestApproval(input, timeoutMs);

    // Only notify when a human is actually being waited on. A bypassed or
    // auto-allowed call resolves synchronously with `id === null`, and
    // pushing a notification for those would train the user to ignore them.
    if (id) {
      // Never let notification delivery affect the decision path: a failed
      // push must not turn into a stalled tool call.
      void dispatchAwaitingPermission({
        slug: projectSlug ?? UNKNOWN_PROJECT_SLUG,
        projectName,
        message: `${toolName} — ${input.summary}`,
      }).catch(() => {});
    }

    return NextResponse.json(buildHookOutput(await outcome));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[/api/hooks/permission]", err);
    return NextResponse.json(
      failOpenHookOutput("Project Minder hit an internal error; falling back to prompt")
    );
  }
}
