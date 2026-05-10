import { NextRequest, NextResponse } from "next/server";
import {
  disableHook,
  enableHook,
  HookToggleError,
  loadDisabledHooks,
  type ToggleScope,
} from "@/lib/hookToggle";
import { invalidateUserConfigCache } from "@/lib/userConfigCache";
import { invalidateClaudeConfigRouteCache } from "../../claude-config/route";
import { TOGGLE_SCOPES } from "@/lib/hookToggle";

/** Lists every entry in the sidecar so the UI can render the
 *  "Disabled (N)" section. */
export async function GET(): Promise<NextResponse> {
  const entries = await loadDisabledHooks();
  return NextResponse.json({ entries });
}

/** Toggle a single hook by id. Body:
 *   { action: "enable"|"disable", scope: "user"|"local",
 *     hookId: string, projectPath?: string }
 *
 *  Returns 200 on success. Errors carry an HTTP status + structured body:
 *   400 INVALID_BODY, INVALID_SCOPE, PROJECT_PATH_REQUIRED
 *   404 NOT_FOUND
 *   409 ALREADY_DISABLED
 *   422 SETTINGS_MALFORMED
 *   500 unexpected
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorJson(400, "INVALID_BODY", "Body must be valid JSON.");
  }

  const action = body.action;
  if (action !== "enable" && action !== "disable") {
    return errorJson(400, "INVALID_BODY", "action must be 'enable' or 'disable'.");
  }

  const scope = body.scope;
  if (typeof scope !== "string" || !TOGGLE_SCOPES.includes(scope as ToggleScope)) {
    return errorJson(
      400,
      "INVALID_SCOPE",
      `scope must be one of: ${TOGGLE_SCOPES.join(", ")}. Plugin- and project-scope hooks are not toggleable.`,
    );
  }

  const hookId = body.hookId;
  if (typeof hookId !== "string" || hookId.length === 0) {
    return errorJson(400, "INVALID_BODY", "hookId required.");
  }

  const projectPath = typeof body.projectPath === "string" ? body.projectPath : undefined;

  try {
    const result =
      action === "disable"
        ? await disableHook({ scope: scope as ToggleScope, hookId, projectPath })
        : await enableHook({ scope: scope as ToggleScope, hookId, projectPath });

    // Hook settings live in user/local-scope JSON files, not in any project
    // metadata the portfolio scan walks — so blowing the global scan cache
    // would force a full 61-project rescan with no real benefit. The
    // userConfig + claude-config caches are the only ones that read these
    // files; invalidate just those.
    invalidateUserConfigCache();
    invalidateClaudeConfigRouteCache();

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof HookToggleError) {
      const status = statusForCode(err.code);
      return errorJson(status, err.code, err.message);
    }
    return errorJson(500, "INTERNAL", (err as Error).message);
  }
}

function statusForCode(code: string): number {
  switch (code) {
    case "PROJECT_PATH_REQUIRED":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_DISABLED":
      return 409;
    case "SETTINGS_MALFORMED":
      return 422;
    default:
      return 500;
  }
}

function errorJson(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}
