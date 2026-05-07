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
import { SENTINEL_UA } from "@/lib/hooks/curlCommand";
import {
  getLiveActivityHookStatus,
  installLiveActivityHooks,
  removeLiveActivityHooks,
  DEFAULT_HOOK_EVENTS,
} from "@/lib/hooks/applyLiveActivity";

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

  it("is idempotent — skips events already having managed entry", async () => {
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makeSettingsWithHooks("http://localhost:4100/api/hooks"));
    // No write should happen since all events already managed
    await installLiveActivityHooks("http://localhost:4100/api/hooks");
    expect(lastWritten).toBe(""); // writeFileAtomic never called
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
});
