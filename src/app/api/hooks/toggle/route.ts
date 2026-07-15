import path from "path";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { NextRequest, NextResponse } from "next/server";
import {
  disableHook,
  enableHook,
  HookToggleError,
  loadDisabledHooks,
  TOGGLE_SCOPES,
  type ToggleScope,
} from "@/lib/hookToggle";
import { invalidateUserConfigCache } from "@/lib/userConfigCache";
import { invalidateClaudeConfigRouteCache } from "../../claude-config/route";
import { getCachedScan, invalidateCache, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";

/** Lists sidecar entries whose source settings file still exists, so the
 *  UI doesn't surface stash entries from deleted/moved projects (re-enabling
 *  one of those would mkdir at the stale path). */
export async function GET(): Promise<NextResponse> {
  const entries = await loadDisabledHooks({ onlyExisting: true });
  return NextResponse.json({ entries });
}

/** Toggle a single hook by id. Body:
 *   { action: "enable"|"disable", scope: "user"|"local",
 *     hookId: string, projectPath?: string }
 *
 *  Returns 200 on success. Errors carry an HTTP status + structured body:
 *   400 INVALID_BODY, INVALID_SCOPE, PROJECT_PATH_REQUIRED, PATH_NOT_ALLOWED
 *   404 NOT_FOUND
 *   409 ALREADY_DISABLED
 *   422 SETTINGS_MALFORMED
 *   500 unexpected
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
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

  // For local scope, projectPath becomes part of the filesystem write target
  // (`<projectPath>/.claude/settings.local.json`). Without validation, a
  // crafted body could write outside scanned projects. Allowlist against
  // the live scan so we only ever write into a known project root.
  if (scope === "local") {
    const allowed = await isAllowedProjectPath(projectPath);
    if (!allowed) {
      return errorJson(
        400,
        "PATH_NOT_ALLOWED",
        "projectPath must be the absolute root of a scanned project.",
      );
    }
  }

  try {
    const result =
      action === "disable"
        ? await disableHook({ scope: scope as ToggleScope, hookId, projectPath })
        : await enableHook({ scope: scope as ToggleScope, hookId, projectPath });

    // Always invalidate the user-config + claude-config caches (both
    // surface user-scope hooks). For local-scope toggles also nuke the
    // scan cache so the affected project's `.claude/settings.local.json`
    // is re-read on next dashboard load — `scanClaudeHooks` reads it as
    // part of the scan, so without this invalidation the row would still
    // appear as "active" in `/api/claude-config?type=hooks` until the
    // 5-min TTL elapses.
    invalidateUserConfigCache();
    invalidateClaudeConfigRouteCache();
    if (scope === "local") {
      invalidateCache();
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof HookToggleError) {
      const status = statusForCode(err.code);
      return errorJson(status, err.code, err.message);
    }
    return errorJson(500, "INTERNAL", (err as Error).message);
  }
}

/** Check projectPath against the live scan. Returns false for any path
 *  that isn't the absolute root of a known scanned project (this also
 *  rejects undefined, relative paths, and paths with `..` traversal that
 *  happen to resolve to a scanned root — the comparison is on the
 *  resolved canonical form). */
async function isAllowedProjectPath(projectPath: string | undefined): Promise<boolean> {
  if (typeof projectPath !== "string" || projectPath.length === 0) return false;
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const resolved = path.resolve(projectPath);
  return scan.projects.some((p) => p.path && path.resolve(p.path) === resolved);
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
