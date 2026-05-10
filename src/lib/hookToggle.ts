import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { withFileLock, writeFileAtomic } from "./atomicWrite";
import { recordPreWrite } from "./configHistory";
import { tryParseJsonc } from "./scanner/util/jsonc";
import { makeHookKey } from "./template/unitKey";

// Hook enable/disable via sidecar stash.
//
// Claude Code's settings.json schema has no `disabled` field for hooks, so
// disabling has to remove the entry outright. To keep that reversible we
// stash the original entry (with enough position metadata to put it back) in
// `~/.claude/.minder/disabled-hooks.json`. Re-enable pops the stash entry and
// re-inserts at the original position, clamped if the surrounding tree has
// shifted.
//
// Scope filter: only `user` (~/.claude/settings.json) and `local`
// (<project>/.claude/settings.local.json) are toggleable. Project-scope
// (`.claude/settings.json`) is intentionally rejected — it's git-tracked, so
// a "personal disable" would dirty the repo for teammates. Plugin-bundled
// hooks are owned by the plugin author; toggle the plugin instead.
//
// Lock order is always (settings, then sidecar) to avoid cross-chain
// deadlock — withFileLock is FIFO per path, so two chains acquiring in
// opposite orders will hang.

export const TOGGLE_SCOPES = ["user", "local"] as const;
export type ToggleScope = (typeof TOGGLE_SCOPES)[number];

export interface DisabledHookEntry {
  /** makeHookKey(event, matcher, command) — same key the apply layer uses. */
  hookId: string;
  scope: ToggleScope;
  /** Absolute path of the settings file the entry was removed from. */
  settingsPath: string;
  event: string;
  matcher?: string;
  /** Raw JSON object as found in settings, preserved byte-equal so re-enable
   *  round-trips identically (the apply layer drops missing optional fields,
   *  which would not be byte-equal). */
  rawCommand: unknown;
  /** True if the matcher group already existed (we removed only the command);
   *  false if the entry was the only command in its group (we removed the
   *  whole matcher group too). On re-enable, false means we recreate the group. */
  matcherGroupExisted: boolean;
  /** Index of the matcher group in `hooks.<event>[]` when removed. */
  originalEventIndex: number;
  /** Index of the command within `hooks.<event>[i].hooks[]` when removed. */
  originalHookIndex: number;
  /** ISO timestamp captured at disable time, for sort + diagnostics. */
  removedAt: string;
}

export interface SidecarSchema {
  version: 1;
  disabled: DisabledHookEntry[];
}

// Computed lazily so tests can redirect os.homedir() per test without
// having to vi.resetModules() the whole module graph.
function sidecarPath(): string {
  return path.join(os.homedir(), ".claude", ".minder", "disabled-hooks.json");
}
function userSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export class HookToggleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HookToggleError";
    this.code = code;
  }
}

/** Resolve the absolute settings file path for the given scope. */
export function resolveSettingsPath(scope: ToggleScope, projectPath?: string): string {
  if (scope === "user") return userSettingsPath();
  if (!projectPath) {
    throw new HookToggleError("PROJECT_PATH_REQUIRED", "local-scope toggle requires projectPath.");
  }
  return path.join(path.resolve(projectPath), ".claude", "settings.local.json");
}

/** Read the sidecar file (always returns a valid schema, even when missing). */
export async function readSidecar(): Promise<SidecarSchema> {
  try {
    const raw = await fs.readFile(sidecarPath(), "utf-8");
    const parsed = tryParseJsonc<SidecarSchema>(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.disabled)) {
      return parsed;
    }
  } catch {
    // missing or unparseable -> empty
  }
  return { version: 1, disabled: [] };
}

/** Public read of the sidecar, optionally narrowed to entries whose
 *  settingsPath still exists on disk. The UI calls this to populate the
 *  "Disabled (N)" section. */
export async function loadDisabledHooks(opts: { onlyExisting?: boolean } = {}): Promise<DisabledHookEntry[]> {
  const sidecar = await readSidecar();
  if (!opts.onlyExisting) return sidecar.disabled.slice();

  const checks = await Promise.all(
    sidecar.disabled.map(async (e) => {
      try {
        await fs.access(e.settingsPath);
        return e;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((e): e is DisabledHookEntry => e !== null);
}

async function writeSidecar(next: SidecarSchema): Promise<void> {
  await fs.mkdir(path.dirname(sidecarPath()), { recursive: true });
  await writeFileAtomic(sidecarPath(), JSON.stringify(next, null, 2) + "\n");
}

/** Acquire both the settings file lock AND the sidecar lock in the canonical
 *  order. Both disable and enable hold both locks for their full duration to
 *  keep the settings + sidecar mutations atomic from any concurrent view. */
function withSettingsAndSidecarLock<T>(
  settingsPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withFileLock(settingsPath, () => withFileLock(sidecarPath(), fn));
}

interface MutationResult {
  hookId: string;
  scope: ToggleScope;
  settingsPath: string;
}

/** Disable a hook by hookId. Removes the matching command from settings,
 *  appends the original to the sidecar.
 *
 *  Throws HookToggleError with codes:
 *   - NOT_FOUND          settings file lacks a command matching hookId
 *   - ALREADY_DISABLED   sidecar already has an entry with this hookId
 *   - SETTINGS_MALFORMED settings file is not valid JSON
 */
export async function disableHook(opts: {
  scope: ToggleScope;
  hookId: string;
  projectPath?: string;
}): Promise<MutationResult> {
  const settingsPath = resolveSettingsPath(opts.scope, opts.projectPath);

  return withSettingsAndSidecarLock(settingsPath, async () => {
    const doc = await readSettings(settingsPath);
    const hooksObj = (doc.hooks as Record<string, unknown> | undefined) ?? {};

    const located = locateCommand(hooksObj, opts.hookId);
    if (!located) {
      throw new HookToggleError("NOT_FOUND", `No active hook with id ${opts.hookId} in ${settingsPath}.`);
    }

    const sidecar = await readSidecar();
    // Scope by (hookId, settingsPath) — two settings files can legitimately
    // carry the same `event+matcher+command` tuple (user vs local, or two
    // projects with identical local hooks). makeHookKey() omits scope, so
    // checking only hookId would falsely 409 the second one.
    if (
      sidecar.disabled.some(
        (e) => e.hookId === opts.hookId && e.settingsPath === settingsPath,
      )
    ) {
      throw new HookToggleError(
        "ALREADY_DISABLED",
        `Hook ${opts.hookId} from ${settingsPath} is already in the disabled stash.`,
      );
    }

    await recordPreWrite(settingsPath, { label: "hookToggle:disable" }).catch(() => {});

    const newDoc = removeCommand(doc, located);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, JSON.stringify(newDoc, null, 2) + "\n");

    const entry: DisabledHookEntry = {
      hookId: opts.hookId,
      scope: opts.scope,
      settingsPath,
      event: located.event,
      matcher: located.matcher,
      rawCommand: located.rawCommand,
      matcherGroupExisted: located.matcherGroupExisted,
      originalEventIndex: located.eventIndex,
      originalHookIndex: located.hookIndex,
      removedAt: new Date().toISOString(),
    };
    await writeSidecar({ version: 1, disabled: [...sidecar.disabled, entry] });

    return { hookId: opts.hookId, scope: opts.scope, settingsPath };
  });
}

/** Re-enable a previously disabled hook. Pops the sidecar entry and
 *  re-inserts at the original position, clamped if the tree has shifted.
 *
 *  Throws HookToggleError with codes:
 *   - NOT_FOUND          sidecar has no entry for hookId
 *   - SETTINGS_MALFORMED settings file is not valid JSON
 */
export async function enableHook(opts: {
  scope: ToggleScope;
  hookId: string;
  projectPath?: string;
}): Promise<MutationResult> {
  const settingsPath = resolveSettingsPath(opts.scope, opts.projectPath);

  return withSettingsAndSidecarLock(settingsPath, async () => {
    const sidecar = await readSidecar();
    const idx = sidecar.disabled.findIndex(
      (e) => e.hookId === opts.hookId && e.settingsPath === settingsPath,
    );
    if (idx < 0) {
      throw new HookToggleError(
        "NOT_FOUND",
        `No disabled hook with id ${opts.hookId} for ${settingsPath}.`,
      );
    }
    const entry = sidecar.disabled[idx];

    const doc = await readSettings(settingsPath);

    await recordPreWrite(settingsPath, { label: "hookToggle:enable" }).catch(() => {});

    const newDoc = restoreCommand(doc, entry);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, JSON.stringify(newDoc, null, 2) + "\n");

    await writeSidecar({
      version: 1,
      disabled: sidecar.disabled.filter((_, i) => i !== idx),
    });

    return { hookId: opts.hookId, scope: opts.scope, settingsPath };
  });
}

// ─── settings file IO ─────────────────────────────────────────────────────

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    if (raw.trim().length === 0) return {};
    const parsed = tryParseJsonc<Record<string, unknown>>(raw);
    if (parsed === null) {
      throw new HookToggleError("SETTINGS_MALFORMED", `${settingsPath} is not valid JSON.`);
    }
    return parsed ?? {};
  } catch (err) {
    if (err instanceof HookToggleError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

// ─── tree walk + mutation ─────────────────────────────────────────────────

interface LocatedCommand {
  event: string;
  matcher?: string;
  /** Index of the matcher group in `hooks.<event>[]`. */
  eventIndex: number;
  /** Index of the command in `hooks.<event>[i].hooks[]`. */
  hookIndex: number;
  /** Whether the matcher group has more than one command (true → matcher
   *  group survives the removal; false → group will be removed too). */
  matcherGroupExisted: boolean;
  /** Raw JSON object as found, for byte-equal restore. */
  rawCommand: unknown;
}

/** Walk the hooks tree to find the (event, matcher, command) tuple whose
 *  makeHookKey matches the given hookId. Returns the first match — the
 *  apply layer is also one-command-per-key, so a unique match is expected. */
function locateCommand(
  hooksObj: Record<string, unknown>,
  hookId: string,
): LocatedCommand | null {
  for (const [event, group] of Object.entries(hooksObj)) {
    if (!Array.isArray(group)) continue;
    for (let i = 0; i < group.length; i++) {
      const matcherGroup = group[i];
      if (!matcherGroup || typeof matcherGroup !== "object") continue;
      const mg = matcherGroup as { matcher?: unknown; hooks?: unknown };
      const matcher = typeof mg.matcher === "string" ? mg.matcher : undefined;
      const hooksArr = Array.isArray(mg.hooks) ? mg.hooks : [];
      for (let j = 0; j < hooksArr.length; j++) {
        const cmd = hooksArr[j];
        if (!cmd || typeof cmd !== "object") continue;
        const command = (cmd as { command?: unknown }).command;
        if (typeof command !== "string") continue;
        if (makeHookKey(event, matcher, command) === hookId) {
          return {
            event,
            matcher,
            eventIndex: i,
            hookIndex: j,
            matcherGroupExisted: hooksArr.length > 1,
            rawCommand: cmd,
          };
        }
      }
    }
  }
  return null;
}

/** Return a new settings doc with the located command removed, pruning
 *  empty matcher groups, event arrays, and the `hooks` key in turn. */
function removeCommand(
  doc: Record<string, unknown>,
  located: LocatedCommand,
): Record<string, unknown> {
  const hooksObj = { ...((doc.hooks as Record<string, unknown> | undefined) ?? {}) };
  const eventArr = (hooksObj[located.event] as unknown[]).slice();
  const matcherGroup = eventArr[located.eventIndex] as Record<string, unknown>;
  const hooksArr = (matcherGroup.hooks as unknown[]).slice();

  hooksArr.splice(located.hookIndex, 1);

  if (hooksArr.length === 0) {
    eventArr.splice(located.eventIndex, 1);
  } else {
    eventArr[located.eventIndex] = { ...matcherGroup, hooks: hooksArr };
  }

  if (eventArr.length === 0) {
    delete hooksObj[located.event];
  } else {
    hooksObj[located.event] = eventArr;
  }

  if (Object.keys(hooksObj).length === 0) {
    const { hooks: _omit, ...rest } = doc;
    return rest;
  }
  return { ...doc, hooks: hooksObj };
}

/** Re-insert a stashed command. If the matcher group still exists at any
 *  index, the command is inserted into that group's hooks array at
 *  originalHookIndex (clamped). Otherwise a fresh matcher group is created
 *  at originalEventIndex (clamped). */
function restoreCommand(
  doc: Record<string, unknown>,
  entry: DisabledHookEntry,
): Record<string, unknown> {
  const hooksObj = { ...((doc.hooks as Record<string, unknown> | undefined) ?? {}) };
  const eventArr = Array.isArray(hooksObj[entry.event])
    ? (hooksObj[entry.event] as unknown[]).slice()
    : [];

  const existingIdx = eventArr.findIndex((g) => {
    if (!g || typeof g !== "object") return false;
    const m = (g as { matcher?: unknown }).matcher;
    return (typeof m === "string" ? m : undefined) === entry.matcher;
  });

  if (existingIdx >= 0) {
    const group = eventArr[existingIdx] as Record<string, unknown>;
    const hooksArr = Array.isArray(group.hooks) ? (group.hooks as unknown[]).slice() : [];
    const insertAt = clamp(entry.originalHookIndex, 0, hooksArr.length);
    hooksArr.splice(insertAt, 0, entry.rawCommand);
    eventArr[existingIdx] = { ...group, hooks: hooksArr };
  } else {
    const newGroup: Record<string, unknown> = entry.matcher
      ? { matcher: entry.matcher, hooks: [entry.rawCommand] }
      : { hooks: [entry.rawCommand] };
    const insertAt = clamp(entry.originalEventIndex, 0, eventArr.length);
    eventArr.splice(insertAt, 0, newGroup);
  }

  hooksObj[entry.event] = eventArr;
  return { ...doc, hooks: hooksObj };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return hi;
  return Math.max(lo, Math.min(hi, n));
}
