import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { withFileLock, writeFileAtomic } from "@/lib/atomicWrite";
import { recordPreWrite } from "@/lib/configHistory";
import {
  buildCurlCommand,
  buildApprovalCurlCommand,
  deriveApprovalUrl,
  isManagedCommand,
  isApprovalCommand,
} from "./curlCommand";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "@/lib/approvals/store";
import { tryParseJsonc } from "@/lib/scanner/util/jsonc";
import type { HookEventName } from "@/lib/types";

const USER_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

/** Events we register by default when the user installs Project Minder hooks. */
export const DEFAULT_HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
];

interface HookEntry {
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/**
 * Claude Code kills a hook process at its own `timeout` (seconds). For the
 * blocking approval hook that ceiling has to sit ABOVE the server's decide
 * deadline, or Claude would reap curl mid-wait and the gate would silently
 * only ever give you `timeout / 1000` seconds to answer no matter what the
 * server was told. Ordered deliberately: server deadline < curl --max-time
 * < this. Each outer layer is a backstop for the one inside it.
 */
const APPROVAL_HOOK_TIMEOUT_SEC = Math.ceil(DEFAULT_APPROVAL_TIMEOUT_MS / 1000) + 10;

async function readUserSettings(targetPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(targetPath, "utf-8");
    const parsed = tryParseJsonc<Record<string, unknown>>(raw);
    if (parsed === null) throw new Error(`${targetPath} is malformed JSON — fix the file before retrying`);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Inspect ~/.claude/settings.json to see which Project Minder-managed hook
 * events are currently registered.
 */
export async function getLiveActivityHookStatus(): Promise<{
  installed: boolean;
  eventsRegistered: HookEventName[];
  /** True once the blocking approval command is present on `PreToolUse`.
   *  Reported separately from `installed` so an older install — which has
   *  managed hooks but not this one — is distinguishable from a current one:
   *  the `blockingApprovals` flag does nothing until this is true. */
  approvalHookRegistered: boolean;
}> {
  const doc = await readUserSettings(USER_SETTINGS_PATH);
  const hooksObj = (doc.hooks ?? {}) as Record<string, HookEntry[]>;
  const registered: HookEventName[] = [];
  for (const event of DEFAULT_HOOK_EVENTS) {
    const groups = hooksObj[event] ?? [];
    const hasManagedEntry = groups.some((g) => g.hooks?.some((h) => isManagedCommand(h.command ?? "")));
    if (hasManagedEntry) registered.push(event);
  }
  const approvalHookRegistered = (hooksObj["PreToolUse"] ?? []).some((g) =>
    g.hooks?.some((h) => isApprovalCommand(h.command ?? "")),
  );
  return { installed: registered.length > 0, eventsRegistered: registered, approvalHookRegistered };
}

/**
 * Write Project Minder lifecycle hook entries into ~/.claude/settings.json.
 * Idempotent: skips events that already have a managed entry. Atomic write
 * with COW snapshot via configHistory.
 */
export async function installLiveActivityHooks(
  hookUrl: string,
  events: HookEventName[] = DEFAULT_HOOK_EVENTS,
): Promise<void> {
  const command = buildCurlCommand(hookUrl);
  const approvalCommand = buildApprovalCurlCommand(
    deriveApprovalUrl(hookUrl),
    DEFAULT_APPROVAL_TIMEOUT_MS,
  );
  await withFileLock(USER_SETTINGS_PATH, async () => {
    const doc = await readUserSettings(USER_SETTINGS_PATH);
    if (!doc.hooks || typeof doc.hooks !== "object") doc.hooks = {};
    const hooksObj = doc.hooks as Record<string, HookEntry[]>;
    let changed = false;
    for (const event of events) {
      hooksObj[event] ??= [];
      const groups = hooksObj[event] as HookEntry[];
      // Each command kind is checked against its own predicate. Asking the
      // broad `isManagedCommand` here would let the approval entry — which now
      // also matches it — stand in for the lifecycle entry and suppress it.
      const hasLifecycle = groups.some((g) =>
        g.hooks?.some((h) => {
          const c = h.command ?? "";
          return isManagedCommand(c) && !isApprovalCommand(c);
        }),
      );
      if (!hasLifecycle) {
        groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });
        changed = true;
      }

      // The blocking approval receiver is a SECOND entry on PreToolUse, not a
      // replacement for the first: the fire-and-forget entry is what records
      // tool activity for the dashboard, and dropping it to make room would
      // trade one feature for another.
      //
      // It is registered unconditionally, independent of the
      // `blockingApprovals` flag, because installation happens once and the
      // flag is toggled later. Gating the *install* on the flag is the bug
      // Codex caught: a user who flips the toggle in Settings would get no
      // gate at all until they reinstalled hooks. The route evaluates the
      // flag per request instead and returns `ask` — Claude's normal prompt —
      // whenever it is off, so a registered-but-disabled hook costs one
      // localhost round-trip and changes nothing else.
      //
      // Checked with `isApprovalCommand`, NOT `isManagedCommand`: an existing
      // install already has a managed PreToolUse entry, and the coarser test
      // would skip the upgrade forever.
      if (event === "PreToolUse") {
        const hasApproval = groups.some((g) =>
          g.hooks?.some((h) => isApprovalCommand(h.command ?? "")),
        );
        if (!hasApproval) {
          groups.push({
            hooks: [
              { type: "command", command: approvalCommand, timeout: APPROVAL_HOOK_TIMEOUT_SEC },
            ],
          });
          changed = true;
        }
      }
    }
    if (!changed) return;
    await recordPreWrite(USER_SETTINGS_PATH, { label: "applyLiveActivity" });
    // Ensure parent directory exists (first-run case where ~/.claude/ exists but settings.json doesn't)
    await fs.mkdir(path.dirname(USER_SETTINGS_PATH), { recursive: true });
    await writeFileAtomic(USER_SETTINGS_PATH, JSON.stringify(doc, null, 2) + "\n");
  });
}

/**
 * Remove all Project Minder-managed hook entries from ~/.claude/settings.json.
 * Leaves any other hook entries untouched. Atomic write with COW snapshot.
 */
export async function removeLiveActivityHooks(): Promise<void> {
  await withFileLock(USER_SETTINGS_PATH, async () => {
    const doc = await readUserSettings(USER_SETTINGS_PATH);
    if (!doc.hooks || typeof doc.hooks !== "object") return;
    const hooksObj = doc.hooks as Record<string, HookEntry[]>;
    let changed = false;
    for (const event of Object.keys(hooksObj)) {
      const groups = hooksObj[event] as HookEntry[];
      const filtered: HookEntry[] = [];
      for (const group of groups) {
        const remaining = (group.hooks ?? []).filter((h) => !isManagedCommand(h.command ?? ""));
        if (remaining.length > 0) {
          filtered.push({ ...group, hooks: remaining });
        }
        if (remaining.length !== (group.hooks ?? []).length) changed = true;
      }
      if (filtered.length === 0) {
        delete hooksObj[event];
      } else {
        hooksObj[event] = filtered;
      }
    }
    if (!changed) return;
    await recordPreWrite(USER_SETTINGS_PATH, { label: "removeLiveActivity" });
    await writeFileAtomic(USER_SETTINGS_PATH, JSON.stringify(doc, null, 2) + "\n");
  });
}
