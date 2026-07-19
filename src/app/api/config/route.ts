import { NextRequest, NextResponse } from "next/server";
import { readConfig, mutateConfig } from "@/lib/config";
import { invalidateCache } from "@/lib/cache";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { setProjectStatus } from "@/lib/server/mutations/projectStatus";
import { ProjectStatus, MinderConfig, FeatureFlagKey, PricingRule, ScheduleMode, SCHEDULE_MODES, SubscriptionTier } from "@/lib/types";
import { isFeatureFlagKey } from "@/lib/featureFlags";
import { setPricingRules } from "@/lib/usage/costCalculator";
import { VALID_CURRENCIES } from "@/lib/currencies";
import { listAdapters } from "@/lib/adapters";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";
import {
  isShortcutActionId,
  isValidCombo,
  effectiveShortcuts,
} from "@/lib/keyboardShortcuts";

// Derived from the MinderConfig union types — update both together if options change
const VALID_DEFAULT_SORTS: MinderConfig["defaultSort"][] = ["activity", "name", "claude"];
const VALID_STATUS_FILTERS: MinderConfig["defaultStatusFilter"][] = ["all", "active", "paused", "archived"];
const VALID_VIEW_MODES: MinderConfig["viewMode"][] = ["full", "compact", "list"];
const VALID_SCHEDULE_MODES = SCHEDULE_MODES.map((m) => m.value);

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
  // Set when claudeHomes/pathMappings are being patched: grades are computed
  // from turn sets that depend on both, so cached grades must drop with them.
  let multiHomeChanged = false;
  const patches: Patch[] = [];

  // S5 — widening devRoots is a sensitive write (it gates validateProjectPath /
  // isPathAllowed elsewhere): this PATCH route is origin-protected by
  // src/proxy.ts, which blocks cross-site requests lacking a matching Origin.
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

  // Extra Claude home dirs (multi-home session correlation). Empty array is
  // valid — it clears the extras (the primary ~/.claude is implicit).
  if (Array.isArray(body.claudeHomes)) {
    if (body.claudeHomes.some((h: unknown) => typeof h !== "string")) {
      return NextResponse.json({ error: "claudeHomes elements must be strings" }, { status: 400 });
    }
    const homes = (body.claudeHomes as string[]).map((h) => h.trim()).filter(Boolean);
    patches.push((c) => { c.claudeHomes = homes; });
    multiHomeChanged = true;
  }

  // Cross-environment path prefix mappings ({from, to} pairs, both non-empty).
  if (Array.isArray(body.pathMappings)) {
    for (const m of body.pathMappings as unknown[]) {
      const pair = m as { from?: unknown; to?: unknown };
      if (
        typeof pair !== "object" || pair === null ||
        typeof pair.from !== "string" || !pair.from.trim() ||
        typeof pair.to !== "string" || !pair.to.trim()
      ) {
        return NextResponse.json({ error: "pathMappings entries must be { from, to } non-empty strings" }, { status: 400 });
      }
    }
    const mappings = (body.pathMappings as { from: string; to: string }[])
      .map((m) => ({ from: m.from.trim(), to: m.to.trim() }));
    patches.push((c) => { c.pathMappings = mappings; });
    multiHomeChanged = true;
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
      const LIVE_EVENT_KEYS = ["manual-step-added", "awaiting-permission"] as const;
      const FUTURE_EVENT_KEYS = ["session-errored", "dispatcher-emergency-stop"];
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
        const isLocalhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
        if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalhost)) {
          throw new Error("not https");
        }
      } catch {
        return NextResponse.json({ error: "autoTitle.endpoint must be an HTTPS URL (or http://localhost)" }, { status: 400 });
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

  if (body.otel !== undefined) {
    if (
      typeof body.otel !== "object" ||
      body.otel === null ||
      Array.isArray(body.otel)
    ) {
      return NextResponse.json({ error: "otel must be an object" }, { status: 400 });
    }
    const { endpoint } = body.otel as Record<string, unknown>;
    if (endpoint !== undefined) {
      if (typeof endpoint !== "string") {
        return NextResponse.json({ error: "otel.endpoint must be a string" }, { status: 400 });
      }
      try {
        const u = new URL(endpoint as string);
        const isLocalhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
        if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalhost)) throw new Error();
      } catch {
        return NextResponse.json({ error: "otel.endpoint must be an HTTPS URL (or http://localhost)" }, { status: 400 });
      }
    }
    patches.push((c) => {
      c.otel = {
        ...(c.otel ?? {}),
        ...(endpoint !== undefined ? { endpoint: endpoint as string } : {}),
      };
    });
  }

  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || !VALID_CURRENCIES.has(body.currency)) {
      return NextResponse.json({ error: `currency must be a supported ISO 4217 code (e.g. "EUR", "JPY")` }, { status: 400 });
    }
    patches.push((c) => { c.currency = body.currency as string; });
  }

  let newPricingRules: PricingRule[] | undefined;
  if (body.pricingRules !== undefined) {
    if (!Array.isArray(body.pricingRules)) {
      return NextResponse.json({ error: "pricingRules must be an array" }, { status: 400 });
    }
    const rules: PricingRule[] = [];
    for (let i = 0; i < (body.pricingRules as unknown[]).length; i++) {
      const r = (body.pricingRules as unknown[])[i];
      if (typeof r !== "object" || r === null || Array.isArray(r)) {
        return NextResponse.json({ error: `pricingRules[${i}] must be an object` }, { status: 400 });
      }
      const { pattern, inputUsdPerMillion, outputUsdPerMillion, cacheReadUsdPerMillion, cacheCreateUsdPerMillion } =
        r as Record<string, unknown>;
      if (typeof pattern !== "string" || pattern.trim().length === 0 || pattern.length > 100) {
        return NextResponse.json({ error: `pricingRules[${i}].pattern must be a non-empty string ≤ 100 chars` }, { status: 400 });
      }
      const rateFields = { inputUsdPerMillion, outputUsdPerMillion, cacheReadUsdPerMillion, cacheCreateUsdPerMillion };
      for (const [key, val] of Object.entries(rateFields)) {
        if (val !== undefined && (typeof val !== "number" || !isFinite(val) || val < 0 || val > 10000)) {
          return NextResponse.json({ error: `pricingRules[${i}].${key} must be a finite number in 0–10000` }, { status: 400 });
        }
      }
      rules.push({
        pattern: pattern.trim(),
        ...(inputUsdPerMillion !== undefined ? { inputUsdPerMillion: inputUsdPerMillion as number } : {}),
        ...(outputUsdPerMillion !== undefined ? { outputUsdPerMillion: outputUsdPerMillion as number } : {}),
        ...(cacheReadUsdPerMillion !== undefined ? { cacheReadUsdPerMillion: cacheReadUsdPerMillion as number } : {}),
        ...(cacheCreateUsdPerMillion !== undefined ? { cacheCreateUsdPerMillion: cacheCreateUsdPerMillion as number } : {}),
      });
    }
    patches.push((c) => { c.pricingRules = rules; });
    newPricingRules = rules;
  }

  if (body.scheduleMode !== undefined) {
    if (!VALID_SCHEDULE_MODES.includes(body.scheduleMode as ScheduleMode)) {
      return NextResponse.json(
        { error: `scheduleMode must be one of: ${VALID_SCHEDULE_MODES.join(", ")}` },
        { status: 400 }
      );
    }
    patches.push((c) => { c.scheduleMode = body.scheduleMode as ScheduleMode; });
  }

  if (body.enabledAdapters !== undefined) {
    if (!Array.isArray(body.enabledAdapters) || body.enabledAdapters.some((id: unknown) => typeof id !== "string")) {
      return NextResponse.json({ error: "enabledAdapters must be an array of strings" }, { status: 400 });
    }
    const knownIds = new Set(listAdapters().map((a) => a.id));
    const ids = body.enabledAdapters as string[];
    const unknown = ids.filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      return NextResponse.json({
        error: `Unknown adapter id(s): ${unknown.join(", ")}. Known adapters: ${[...knownIds].join(", ")}`,
      }, { status: 400 });
    }
    patches.push((c) => { c.enabledAdapters = ids; });
  }

  const VALID_TIERS: SubscriptionTier[] = ["pro", "max5x", "max20x", "api"];

  if (body.subscriptionTier !== undefined) {
    if (body.subscriptionTier !== null && !VALID_TIERS.includes(body.subscriptionTier as SubscriptionTier)) {
      return NextResponse.json({ error: `subscriptionTier must be one of: ${VALID_TIERS.join(", ")} or null` }, { status: 400 });
    }
    patches.push((c) => { c.subscriptionTier = body.subscriptionTier === null ? undefined : body.subscriptionTier as SubscriptionTier; });
  }

  if (body.budgets !== undefined) {
    if (typeof body.budgets !== "object" || body.budgets === null || Array.isArray(body.budgets)) {
      return NextResponse.json({ error: "budgets must be an object" }, { status: 400 });
    }
    const { sessionUsd, dailyUsd } = body.budgets as Record<string, unknown>;
    for (const [key, val] of [["sessionUsd", sessionUsd], ["dailyUsd", dailyUsd]] as const) {
      if (val !== undefined && val !== null && (typeof val !== "number" || !isFinite(val) || val < 0 || val > 100000)) {
        return NextResponse.json({ error: `budgets.${key} must be a finite number in 0–100000 or null` }, { status: 400 });
      }
    }
    patches.push((c) => {
      c.budgets = {
        ...(sessionUsd != null ? { sessionUsd: sessionUsd as number } : {}),
        ...(dailyUsd != null ? { dailyUsd: dailyUsd as number } : {}),
      };
    });
  }

  if (body.keyboardShortcuts !== undefined) {
    if (
      typeof body.keyboardShortcuts !== "object" ||
      body.keyboardShortcuts === null ||
      Array.isArray(body.keyboardShortcuts)
    ) {
      return NextResponse.json({ error: "keyboardShortcuts must be a plain object" }, { status: 400 });
    }
    const overrides = body.keyboardShortcuts as Record<string, unknown>;
    for (const [actionId, combo] of Object.entries(overrides)) {
      if (!isShortcutActionId(actionId)) {
        return NextResponse.json({ error: `Unknown shortcut action: "${actionId}"` }, { status: 400 });
      }
      if (typeof combo !== "string" || !isValidCombo(combo)) {
        return NextResponse.json(
          { error: `Invalid combo for "${actionId}". Use format like "Ctrl+K", "/", or "Shift+T"` },
          { status: 400 }
        );
      }
    }
    // Check the full effective map (defaults + existing overrides + this patch) for duplicates.
    const existing = await readConfig();
    const merged = effectiveShortcuts({
      ...existing.keyboardShortcuts,
      ...(overrides as Record<string, string>),
    });
    const seen = new Map<string, string>();
    for (const [id, combo] of Object.entries(merged)) {
      if (seen.has(combo)) {
        return NextResponse.json(
          { error: `Combo conflict: "${combo}" is used by both "${seen.get(combo)}" and "${id}"` },
          { status: 400 }
        );
      }
      seen.set(combo, id);
    }
    patches.push((c) => { c.keyboardShortcuts = overrides as Record<string, string>; });
  }

  if (patches.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const config = await mutateConfig((c) => {
    for (const patch of patches) patch(c);
  });
  if (newPricingRules !== undefined) setPricingRules(newPricingRules);
  invalidateAll();
  // Grades depend on the multi-home turn set; drop them so the next dashboard
  // enqueue recomputes with the new homes/mappings instead of serving the old
  // grade for the rest of the 5-minute TTL.
  if (multiHomeChanged) efficiencyGradeCache.invalidateGrades();
  return NextResponse.json({ ok: true, config });
}

export async function GET() {
  const config = await readConfig();
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const body = await request.json();

  // Update status — delegates to the same core mutation the
  // `setProjectStatusAction` Server Action calls (it invalidates both caches
  // internally), so the route and action stay behaviourally identical.
  if (body.slug && body.status) {
    await setProjectStatus(body.slug, body.status as ProjectStatus);
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
