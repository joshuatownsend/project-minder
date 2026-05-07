import { NextRequest, NextResponse } from "next/server";
import { readConfig, mutateConfig } from "@/lib/config";
import { invalidateCache } from "@/lib/cache";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { ProjectStatus, MinderConfig, FeatureFlagKey } from "@/lib/types";
import { isFeatureFlagKey } from "@/lib/featureFlags";

// Derived from the MinderConfig union types — update both together if options change
const VALID_DEFAULT_SORTS: MinderConfig["defaultSort"][] = ["activity", "name", "claude"];
const VALID_STATUS_FILTERS: MinderConfig["defaultStatusFilter"][] = ["all", "active", "paused", "archived"];
const VALID_VIEW_MODES: MinderConfig["viewMode"][] = ["full", "compact", "list"];

function invalidateAll() {
  invalidateCache();
  invalidateClaudeConfigRouteCache();
}

// Validate first, mutate second. We can't validate inside `mutateConfig` because
// it always writes — a half-mutated config caused by mid-validation failure
// would be persisted. So we build a list of patch closures up front; only if
// every validation passes do we hand them to `mutateConfig` to apply atomically.
type Patch = (config: MinderConfig) => void;

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const patches: Patch[] = [];

  if (Array.isArray(body.devRoots)) {
    if (body.devRoots.some((r: unknown) => typeof r !== "string")) {
      return NextResponse.json({ error: "devRoots elements must be strings" }, { status: 400 });
    }
    const roots = (body.devRoots as string[]).map((r) => r.trim()).filter(Boolean);
    if (roots.length === 0) {
      return NextResponse.json({ error: "devRoots must not be empty" }, { status: 400 });
    }
    patches.push((c) => {
      c.devRoots = roots;
      c.devRoot = roots[0];
    });
  }

  if (typeof body.scanBatchSize === "number") {
    const size = Math.round(body.scanBatchSize);
    if (size < 1 || size > 50) {
      return NextResponse.json({ error: "scanBatchSize must be 1–50" }, { status: 400 });
    }
    patches.push((c) => { c.scanBatchSize = size; });
  }

  if (body.defaultSort !== undefined) {
    if (!VALID_DEFAULT_SORTS.includes(body.defaultSort)) {
      return NextResponse.json({ error: "Invalid defaultSort" }, { status: 400 });
    }
    patches.push((c) => { c.defaultSort = body.defaultSort; });
  }

  if (body.defaultStatusFilter !== undefined) {
    if (!VALID_STATUS_FILTERS.includes(body.defaultStatusFilter)) {
      return NextResponse.json({ error: "Invalid defaultStatusFilter" }, { status: 400 });
    }
    patches.push((c) => { c.defaultStatusFilter = body.defaultStatusFilter; });
  }

  if (body.viewMode !== undefined) {
    if (!VALID_VIEW_MODES.includes(body.viewMode)) {
      return NextResponse.json({ error: "Invalid viewMode" }, { status: 400 });
    }
    patches.push((c) => { c.viewMode = body.viewMode; });
  }

  if (body.pinnedSlugs !== undefined) {
    if (!Array.isArray(body.pinnedSlugs) || body.pinnedSlugs.some((s: unknown) => typeof s !== "string")) {
      return NextResponse.json({ error: "pinnedSlugs must be an array of strings" }, { status: 400 });
    }
    patches.push((c) => { c.pinnedSlugs = body.pinnedSlugs as string[]; });
  }

  if (body.featureFlags !== undefined) {
    // Partial-merge: unknown keys or non-boolean values reject the whole
    // patch rather than silently dropping (matches no-silent-fallbacks posture).
    if (
      typeof body.featureFlags !== "object" ||
      body.featureFlags === null ||
      Array.isArray(body.featureFlags)
    ) {
      return NextResponse.json({ error: "featureFlags must be an object" }, { status: 400 });
    }

    const sanitized: Partial<Record<FeatureFlagKey, boolean>> = {};
    for (const [key, value] of Object.entries(body.featureFlags)) {
      if (!isFeatureFlagKey(key)) {
        return NextResponse.json({ error: `Unknown feature flag: ${key}` }, { status: 400 });
      }
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: `featureFlags.${key} must be boolean` }, { status: 400 });
      }
      sanitized[key] = value;
    }

    patches.push((c) => {
      c.featureFlags = { ...(c.featureFlags ?? {}), ...sanitized };
    });
  }

  if (body.telegram !== undefined) {
    if (typeof body.telegram !== "object" || body.telegram === null || Array.isArray(body.telegram)) {
      return NextResponse.json({ error: "telegram must be an object" }, { status: 400 });
    }
    // botToken is NOT accepted here — it must go through POST /api/secrets/telegram.
    // Any botToken in the body is silently dropped for forward-compat with stale clients.
    const { chatId } = body.telegram as Record<string, unknown>;
    if (chatId !== undefined) {
      if (typeof chatId !== "string" || chatId.length > 256) {
        return NextResponse.json({ error: "telegram.chatId must be a string ≤ 256 chars" }, { status: 400 });
      }
    }
    patches.push((c) => {
      c.telegram = { ...(c.telegram ?? {}), chatId: typeof chatId === "string" ? chatId : c.telegram?.chatId };
    });
  }

  if (body.terminal !== undefined) {
    if (typeof body.terminal !== "string" || body.terminal.length > 64) {
      return NextResponse.json({ error: "terminal must be a string ≤ 64 chars" }, { status: 400 });
    }
    if (body.terminal !== "" && !/^[a-zA-Z0-9._\-]+$/.test(body.terminal)) {
      return NextResponse.json({ error: "terminal contains invalid characters" }, { status: 400 });
    }
    patches.push((c) => { c.terminal = body.terminal as string; });
  }

  if (body.notificationPrefs !== undefined) {
    if (
      typeof body.notificationPrefs !== "object" ||
      body.notificationPrefs === null ||
      Array.isArray(body.notificationPrefs)
    ) {
      return NextResponse.json({ error: "notificationPrefs must be an object" }, { status: 400 });
    }
    const events = (body.notificationPrefs as Record<string, unknown>).events;
    if (events !== undefined) {
      if (typeof events !== "object" || events === null || Array.isArray(events)) {
        return NextResponse.json({ error: "notificationPrefs.events must be an object" }, { status: 400 });
      }
      // Only manual-step-added has a real fire path this session.
      const LIVE_EVENT_KEYS = ["manual-step-added"] as const;
      const FUTURE_EVENT_KEYS = ["session-errored", "awaiting-permission", "dispatcher-emergency-stop"];
      for (const [key, val] of Object.entries(events as Record<string, unknown>)) {
        if (FUTURE_EVENT_KEYS.includes(key)) {
          return NextResponse.json({
            error: `notificationPrefs.events.${key} is not yet wired — it will be enabled in a future wave`,
          }, { status: 400 });
        }
        if (!(LIVE_EVENT_KEYS as readonly string[]).includes(key)) {
          return NextResponse.json({ error: `Unknown notification event key: ${key}` }, { status: 400 });
        }
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          return NextResponse.json({ error: `notificationPrefs.events.${key} must be an object` }, { status: 400 });
        }
        for (const channel of ["push", "telegram", "os"] as const) {
          const v = (val as Record<string, unknown>)[channel];
          if (v !== undefined && typeof v !== "boolean") {
            return NextResponse.json({
              error: `notificationPrefs.events.${key}.${channel} must be boolean`,
            }, { status: 400 });
          }
        }
      }
    }
    patches.push((c) => {
      c.notificationPrefs = body.notificationPrefs as typeof c.notificationPrefs;
    });
  }

  if (body.autoTitle !== undefined) {
    if (
      typeof body.autoTitle !== "object" ||
      body.autoTitle === null ||
      Array.isArray(body.autoTitle)
    ) {
      return NextResponse.json({ error: "autoTitle must be an object" }, { status: 400 });
    }
    const { endpoint, model } = body.autoTitle as Record<string, unknown>;
    if (endpoint !== undefined) {
      if (typeof endpoint !== "string") {
        return NextResponse.json({ error: "autoTitle.endpoint must be a string" }, { status: 400 });
      }
      try {
        const u = new URL(endpoint as string);
        if (u.protocol !== "https:") throw new Error("not https");
      } catch {
        return NextResponse.json({ error: "autoTitle.endpoint must be an HTTPS URL" }, { status: 400 });
      }
    }
    if (model !== undefined && (typeof model !== "string" || (model as string).length > 128)) {
      return NextResponse.json({ error: "autoTitle.model must be a string ≤ 128 chars" }, { status: 400 });
    }
    patches.push((c) => {
      c.autoTitle = {
        ...(c.autoTitle ?? {}),
        ...(endpoint !== undefined ? { endpoint: endpoint as string } : {}),
        ...(model !== undefined ? { model: model as string } : {}),
      };
    });
  }

  if (patches.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const config = await mutateConfig((c) => {
    for (const patch of patches) patch(c);
  });
  invalidateAll();
  return NextResponse.json({ ok: true, config });
}

export async function GET() {
  const config = await readConfig();
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const body = await request.json();

  // Update status
  if (body.slug && body.status) {
    await mutateConfig((config) => {
      config.statuses[body.slug] = body.status as ProjectStatus;
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Hide a project (by directory name)
  if (body.action === "hide" && body.dirName) {
    await mutateConfig((config) => {
      if (!config.hidden.includes(body.dirName)) {
        config.hidden.push(body.dirName);
      }
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Unhide a project
  if (body.action === "unhide" && body.dirName) {
    await mutateConfig((config) => {
      config.hidden = config.hidden.filter((h) => h !== body.dirName);
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Set port override for a project
  if (body.slug && body.port !== undefined) {
    const port = parseInt(body.port, 10);
    if (port > 0 && port <= 65535) {
      await mutateConfig((config) => {
        config.portOverrides[body.slug] = port;
      });
    } else if (body.port === null || body.port === 0) {
      await mutateConfig((config) => {
        delete config.portOverrides[body.slug];
      });
    } else {
      return NextResponse.json({ error: "Invalid port" }, { status: 400 });
    }
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  // Bulk update hidden list
  if (body.hidden && Array.isArray(body.hidden)) {
    await mutateConfig((config) => {
      config.hidden = body.hidden;
    });
    invalidateAll();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
