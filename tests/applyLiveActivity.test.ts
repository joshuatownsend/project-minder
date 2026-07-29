import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs module
vi.mock("fs", () => {
  const readFile = vi.fn();
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const mkdir = vi.fn().mockResolvedValue(undefined);
  const rename = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    promises: { readFile, writeFile, mkdir, rename, open, close },
    constants: { O_CREAT: 0, O_EXCL: 0 },
  };
});

vi.mock("@/lib/configHistory", () => ({
  recordPreWrite: vi.fn().mockResolvedValue(undefined),
}));

// Mock withFileLock to just call the callback directly
vi.mock("@/lib/atomicWrite", () => ({
  withFileLock: vi.fn(async (_path: string, fn: () => Promise<void>) => fn()),
  writeFileAtomic: vi.fn(async (_path: string, content: string) => {
    // Store last written content so tests can inspect it
    lastWritten = content;
  }),
}));

let lastWritten: string = "";

import { promises as fs } from "fs";
import { SENTINEL_UA, isApprovalCommand } from "@/lib/hooks/curlCommand";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "@/lib/approvals/store";
import {
  getLiveActivityHookStatus,
  installLiveActivityHooks,
  removeLiveActivityHooks,
  DEFAULT_HOOK_EVENTS,
} from "@/lib/hooks/applyLiveActivity";

interface HookGroup {
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/** All command strings registered for one event, flattened across groups. */
function commandsFor(doc: { hooks: Record<string, HookGroup[]> }, event: string): string[] {
  return (doc.hooks[event] ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
}

function makeSettingsWithHooks(hookUrl: string) {
  const hooks: Record<string, unknown[]> = {};
  for (const event of DEFAULT_HOOK_EVENTS) {
    hooks[event] = [
      { hooks: [{ type: "command", command: `curl -A "${SENTINEL_UA}" -X POST "${hookUrl}"`, timeout: 10 }] },
    ];
  }
  return JSON.stringify({ hooks });
}

function makeSettingsEmpty() {
  return JSON.stringify({});
}

describe("getLiveActivityHookStatus", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns installed:false when settings file is missing", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await getLiveActivityHookStatus();
    expect(result.installed).toBe(false);
    expect(result.eventsRegistered).toHaveLength(0);
  });

  it("returns installed:true with all events when hooks are present", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsWithHooks("http://localhost:4100/api/hooks"));
    const result = await getLiveActivityHookStatus();
    expect(result.installed).toBe(true);
    expect(result.eventsRegistered).toHaveLength(DEFAULT_HOOK_EVENTS.length);
  });

  it("reports approvalHookRegistered:false for a pre-approval-gate install", async () => {
    // `installed` alone cannot answer "will the blockingApprovals flag do
    // anything?" — an older install satisfies it while the gate is unreachable.
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSettingsWithHooks("http://localhost:4100/api/hooks"),
    );
    const result = await getLiveActivityHookStatus();
    expect(result.installed).toBe(true);
    expect(result.approvalHookRegistered).toBe(false);
  });

  it("reports approvalHookRegistered:true after a current install", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lastWritten);
    const result = await getLiveActivityHookStatus();
    expect(result.approvalHookRegistered).toBe(true);
  });
});

describe("installLiveActivityHooks", () => {
  beforeEach(() => { vi.clearAllMocks(); lastWritten = ""; });

  it("adds entries for all 6 default events", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const doc = JSON.parse(lastWritten) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(doc.hooks)).toHaveLength(DEFAULT_HOOK_EVENTS.length);
    for (const event of DEFAULT_HOOK_EVENTS) {
      expect(doc.hooks[event]).toBeDefined();
    }
  });

  it("embeds the sentinel in each command", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    expect(lastWritten).toContain(SENTINEL_UA);
  });

  it("is idempotent — a config it wrote itself produces no second write", async () => {
    // Round-trip: install from empty, then feed the result back in. This is
    // the real no-op case. It deliberately does NOT use
    // makeSettingsWithHooks, which models a PRE-approval-gate install and
    // must still be upgraded (see the next test).
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const current = lastWritten;
    expect(current).not.toBe("");

    lastWritten = "";
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(current);
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    expect(lastWritten).toBe(""); // writeFileAtomic never called
  });

  it("upgrades a pre-approval-gate install by adding the blocking PreToolUse entry", async () => {
    // The regression Codex caught: an existing install already has a managed
    // PreToolUse entry, so an `isManagedCommand`-based skip would leave the
    // gate permanently unreachable. Only the approval entry may be added.
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSettingsWithHooks("http://localhost:4100/api/hooks"),
    );
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    expect(lastWritten).not.toBe("");

    const doc = JSON.parse(lastWritten) as { hooks: Record<string, HookGroup[]> };
    expect(commandsFor(doc, "PreToolUse").filter(isApprovalCommand)).toHaveLength(1);
    // Every other event is untouched — one entry each, still the lifecycle one.
    for (const event of DEFAULT_HOOK_EVENTS.filter((e) => e !== "PreToolUse")) {
      expect(commandsFor(doc, event)).toHaveLength(1);
      expect(commandsFor(doc, event).some(isApprovalCommand)).toBe(false);
    }
  });

  it("still adds the lifecycle entry when only the approval entry is present", async () => {
    // The approval command matches `isManagedCommand` too, so a per-event
    // check that used the broad predicate would let it stand in for the
    // lifecycle entry and silently suppress activity recording.
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const full = JSON.parse(lastWritten) as { hooks: Record<string, HookGroup[]> };
    // Strip the lifecycle entry from PreToolUse, keep the approval one.
    full.hooks.PreToolUse = full.hooks.PreToolUse.filter((g) =>
      g.hooks.some((h) => isApprovalCommand(h.command)),
    );

    lastWritten = "";
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(full));
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const doc = JSON.parse(lastWritten) as { hooks: Record<string, HookGroup[]> };
    expect(commandsFor(doc, "PreToolUse").filter((c) => !isApprovalCommand(c))).toHaveLength(1);
    expect(commandsFor(doc, "PreToolUse").filter(isApprovalCommand)).toHaveLength(1);
  });

  it("registers the blocking command on PreToolUse only, pointing at /permission", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const doc = JSON.parse(lastWritten) as { hooks: Record<string, HookGroup[]> };

    const approval = commandsFor(doc, "PreToolUse").filter(isApprovalCommand);
    expect(approval).toHaveLength(1);
    expect(approval[0]).toContain("/api/hooks/permission");
    // The fire-and-forget entry survives: the gate must not cost us the
    // activity recording that PreToolUse already provided.
    expect(commandsFor(doc, "PreToolUse").filter((c) => !isApprovalCommand(c))).toHaveLength(1);

    for (const event of DEFAULT_HOOK_EVENTS.filter((e) => e !== "PreToolUse")) {
      expect(commandsFor(doc, event).some(isApprovalCommand)).toBe(false);
    }
  });

  it("gives the blocking hook a Claude-side timeout above the server deadline", async () => {
    // If Claude's own hook timeout were the smallest of the three, it would
    // reap curl mid-wait and the gate would silently allow far less time to
    // decide than it was configured with.
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const doc = JSON.parse(lastWritten) as { hooks: Record<string, HookGroup[]> };

    const entry = doc.hooks.PreToolUse.flatMap((g) => g.hooks).find((h) =>
      isApprovalCommand(h.command),
    );
    expect(entry).toBeDefined();
    const curlMaxTime = Number(/--max-time (\d+)/.exec(entry!.command)?.[1]);
    const serverDeadlineSec = DEFAULT_APPROVAL_TIMEOUT_MS / 1000;
    expect(serverDeadlineSec).toBeLessThan(curlMaxTime);
    expect(curlMaxTime).toBeLessThan(entry!.timeout!);
  });

  it("preserves unrelated hook entries", async () => {
    const existing = JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "echo user-hook" }] },
        ],
      },
    });
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const doc = JSON.parse(lastWritten) as { hooks: Record<string, unknown[]> };
    // PreToolUse should have both user's hook and our managed hook
    expect((doc.hooks["PreToolUse"] as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});

describe("removeLiveActivityHooks", () => {
  beforeEach(() => { vi.clearAllMocks(); lastWritten = ""; });

  it("removes all sentinel-tagged entries", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsWithHooks("http://localhost:4100/api/hooks"));
    await removeLiveActivityHooks();
    const doc = JSON.parse(lastWritten) as { hooks?: Record<string, unknown[]> };
    // All event keys should be removed (no remaining groups)
    expect(doc.hooks ?? {}).toEqual({});
  });

  it("leaves non-managed hooks intact", async () => {
    const existing = JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: `curl -A "${SENTINEL_UA}" -X POST "http://localhost:4100/api/hooks"` }] },
          { hooks: [{ type: "command", command: "echo user-hook" }] },
        ],
      },
    });
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    await removeLiveActivityHooks();
    const doc = JSON.parse(lastWritten) as { hooks: Record<string, unknown[]> };
    expect((doc.hooks["PreToolUse"] as unknown[]).length).toBe(1);
  });

  it("is a no-op when nothing is installed", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await removeLiveActivityHooks();
    expect(lastWritten).toBe(""); // no write
  });

  it("removes the blocking approval entry too, not just the lifecycle one", async () => {
    // The approval command carries its OWN sentinel, so uninstall would leave
    // a live gate behind if `isManagedCommand` did not match both.
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsEmpty());
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    const installed = lastWritten;
    expect(installed).toContain("/api/hooks/permission");

    lastWritten = "";
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(installed);
    await removeLiveActivityHooks();
    const doc = JSON.parse(lastWritten) as { hooks?: Record<string, unknown[]> };
    expect(doc.hooks ?? {}).toEqual({});
  });
});
