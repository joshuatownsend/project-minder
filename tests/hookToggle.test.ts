import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { makeHookKey } from "@/lib/template/unitKey";

// hookToggle resolves both the user settings file AND the sidecar via
// os.homedir(), so a per-test mkdtemp + os.homedir() spy keeps the real
// home directory untouched. configHistory does the same trick — see
// tests/configHistory.test.ts.

let tmpHome: string;
let tmpProject: string;

async function loadModule() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return await import("@/lib/hookToggle");
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-hookToggle-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "pm-hookToggle-proj-"));
  await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });
  await fs.mkdir(path.join(tmpProject, ".claude"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
});

const userSettings = () => path.join(tmpHome, ".claude", "settings.json");
const localSettings = () => path.join(tmpProject, ".claude", "settings.local.json");
const sidecar = () => path.join(tmpHome, ".claude", ".minder", "disabled-hooks.json");

async function writeJson(p: string, v: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v, null, 2) + "\n", "utf-8");
}

async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw) as T;
}

const sampleHook = (cmd: string) => ({ type: "command", command: cmd });

describe("resolveSettingsPath", () => {
  it("returns user settings.json for scope=user", async () => {
    const { resolveSettingsPath } = await loadModule();
    expect(resolveSettingsPath("user")).toBe(userSettings());
  });

  it("returns project's settings.local.json for scope=local", async () => {
    const { resolveSettingsPath } = await loadModule();
    expect(resolveSettingsPath("local", tmpProject)).toBe(localSettings());
  });

  it("throws PROJECT_PATH_REQUIRED when scope=local and no projectPath", async () => {
    const { resolveSettingsPath, HookToggleError } = await loadModule();
    expect(() => resolveSettingsPath("local")).toThrow(HookToggleError);
  });
});

describe("disableHook → enableHook round-trip", () => {
  it("preserves the matcher group's command byte-equal across the cycle", async () => {
    const { disableHook, enableHook } = await loadModule();
    const before = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [sampleHook("echo first"), sampleHook("echo second")],
          },
        ],
      },
    };
    await writeJson(userSettings(), before);
    const beforeBytes = await fs.readFile(userSettings(), "utf-8");

    const hookId = makeHookKey("PostToolUse", "Edit", "echo second");
    await disableHook({ scope: "user", hookId });

    // first hook still present, second moved to sidecar
    const mid = await readJson<Record<string, unknown>>(userSettings());
    const grp = (mid.hooks as Record<string, unknown[]>).PostToolUse[0] as { hooks: unknown[] };
    expect(grp.hooks).toHaveLength(1);
    expect((grp.hooks[0] as { command: string }).command).toBe("echo first");

    await enableHook({ scope: "user", hookId });

    const afterBytes = await fs.readFile(userSettings(), "utf-8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("leaves matcher group present when disabling one of N commands", async () => {
    const { disableHook } = await loadModule();
    await writeJson(userSettings(), {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [sampleHook("c1"), sampleHook("c2"), sampleHook("c3")],
          },
        ],
      },
    });

    const hookId = makeHookKey("PostToolUse", "Edit", "c2");
    await disableHook({ scope: "user", hookId });

    const doc = await readJson<Record<string, unknown>>(userSettings());
    const grp = (doc.hooks as Record<string, unknown[]>).PostToolUse[0] as { hooks: unknown[] };
    expect(grp.hooks.map((h) => (h as { command: string }).command)).toEqual(["c1", "c3"]);
  });
});

describe("disableHook pruning", () => {
  it("removes empty matcher group, event array, and hooks key when last command leaves", async () => {
    const { disableHook } = await loadModule();
    await writeJson(userSettings(), {
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [sampleHook("only")] }],
      },
      otherKey: 42,
    });

    const hookId = makeHookKey("PostToolUse", "Edit", "only");
    await disableHook({ scope: "user", hookId });

    const doc = await readJson<Record<string, unknown>>(userSettings());
    expect(doc.hooks).toBeUndefined();
    expect(doc.otherKey).toBe(42);
  });

  it("keeps other event groups when one event becomes empty", async () => {
    const { disableHook } = await loadModule();
    await writeJson(userSettings(), {
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [sampleHook("a")] }],
        PreToolUse: [{ matcher: "Bash", hooks: [sampleHook("b")] }],
      },
    });

    const hookId = makeHookKey("PostToolUse", "Edit", "a");
    await disableHook({ scope: "user", hookId });

    const doc = await readJson<{ hooks: Record<string, unknown> }>(userSettings());
    expect(doc.hooks.PostToolUse).toBeUndefined();
    expect(doc.hooks.PreToolUse).toBeDefined();
  });
});

describe("enableHook into pruned tree", () => {
  it("recreates matcher group + event array if the surrounding tree was emptied", async () => {
    const { disableHook, enableHook } = await loadModule();
    await writeJson(userSettings(), {
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [sampleHook("solo")] }],
      },
    });

    const hookId = makeHookKey("PostToolUse", "Edit", "solo");
    await disableHook({ scope: "user", hookId });

    const mid = await readJson<Record<string, unknown>>(userSettings());
    expect(mid.hooks).toBeUndefined();

    await enableHook({ scope: "user", hookId });

    const doc = await readJson<{ hooks: Record<string, unknown[]> }>(userSettings());
    const grp = doc.hooks.PostToolUse[0] as { matcher: string; hooks: unknown[] };
    expect(grp.matcher).toBe("Edit");
    expect((grp.hooks[0] as { command: string }).command).toBe("solo");
  });
});

describe("error cases", () => {
  it("disableHook throws NOT_FOUND when no command matches hookId", async () => {
    const { disableHook, HookToggleError } = await loadModule();
    await writeJson(userSettings(), { hooks: {} });
    await expect(disableHook({ scope: "user", hookId: "nope" })).rejects.toThrow(HookToggleError);
  });

  it("disableHook throws ALREADY_DISABLED if hookId already in sidecar", async () => {
    const { disableHook } = await loadModule();
    await writeJson(userSettings(), {
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [sampleHook("c1"), sampleHook("c2")] },
        ],
      },
    });
    const hookId = makeHookKey("PostToolUse", "Edit", "c1");
    await disableHook({ scope: "user", hookId });

    // Add the same command back manually so the second disable would otherwise succeed.
    const doc = await readJson<{ hooks: Record<string, unknown[]> }>(userSettings());
    (doc.hooks.PostToolUse[0] as { hooks: unknown[] }).hooks.unshift(sampleHook("c1"));
    await writeJson(userSettings(), doc);

    await expect(disableHook({ scope: "user", hookId })).rejects.toMatchObject({
      code: "ALREADY_DISABLED",
    });
  });

  it("enableHook throws NOT_FOUND when sidecar has no matching entry", async () => {
    const { enableHook, HookToggleError } = await loadModule();
    await expect(enableHook({ scope: "user", hookId: "missing" })).rejects.toThrow(HookToggleError);
  });

  it("disableHook throws SETTINGS_MALFORMED on invalid JSON", async () => {
    const { disableHook } = await loadModule();
    await fs.mkdir(path.dirname(userSettings()), { recursive: true });
    await fs.writeFile(userSettings(), "not json", "utf-8");
    await expect(disableHook({ scope: "user", hookId: "x" })).rejects.toMatchObject({
      code: "SETTINGS_MALFORMED",
    });
  });
});

describe("local scope (project's settings.local.json)", () => {
  it("disable + enable round-trip writes to settings.local.json", async () => {
    const { disableHook, enableHook } = await loadModule();
    await writeJson(localSettings(), {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [sampleHook("ls")] }],
      },
    });
    const before = await fs.readFile(localSettings(), "utf-8");

    const hookId = makeHookKey("PreToolUse", "Bash", "ls");
    await disableHook({ scope: "local", hookId, projectPath: tmpProject });
    await enableHook({ scope: "local", hookId, projectPath: tmpProject });

    expect(await fs.readFile(localSettings(), "utf-8")).toBe(before);
  });
});

describe("scope-isolated uniqueness", () => {
  it("same hookId in user vs local can both be disabled (no false ALREADY_DISABLED)", async () => {
    // makeHookKey omits scope/path, so the same event+matcher+command
    // produces an identical hookId across settings files. Disabling the
    // user copy must not block disabling the local copy — the sidecar
    // ALREADY_DISABLED guard is keyed by (hookId, settingsPath).
    const { disableHook, loadDisabledHooks } = await loadModule();
    await writeJson(userSettings(), {
      hooks: { Stop: [{ hooks: [sampleHook("ping")] }] },
    });
    await writeJson(localSettings(), {
      hooks: { Stop: [{ hooks: [sampleHook("ping")] }] },
    });

    const hookId = makeHookKey("Stop", undefined, "ping");
    await disableHook({ scope: "user", hookId });
    await disableHook({ scope: "local", hookId, projectPath: tmpProject });

    const entries = await loadDisabledHooks();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.scope).sort()).toEqual(["local", "user"]);
  });
});

describe("loadDisabledHooks({ onlyExisting: true })", () => {
  it("filters out entries whose source settings file no longer exists", async () => {
    const { disableHook, loadDisabledHooks } = await loadModule();
    await writeJson(userSettings(), {
      hooks: { Stop: [{ hooks: [sampleHook("u")] }] },
    });
    await writeJson(localSettings(), {
      hooks: { Stop: [{ hooks: [sampleHook("l")] }] },
    });

    await disableHook({ scope: "user", hookId: makeHookKey("Stop", undefined, "u") });
    await disableHook({
      scope: "local",
      hookId: makeHookKey("Stop", undefined, "l"),
      projectPath: tmpProject,
    });

    // Simulate the project being deleted out from under the sidecar entry.
    await fs.rm(tmpProject, { recursive: true, force: true });

    const allEntries = await loadDisabledHooks();
    const liveEntries = await loadDisabledHooks({ onlyExisting: true });

    expect(allEntries).toHaveLength(2);
    expect(liveEntries).toHaveLength(1);
    expect(liveEntries[0].scope).toBe("user");
  });
});

describe("sidecar contents", () => {
  it("loadDisabledHooks reflects what disableHook just wrote", async () => {
    const { disableHook, loadDisabledHooks } = await loadModule();
    await writeJson(userSettings(), {
      hooks: {
        Stop: [{ hooks: [sampleHook("notify")] }],
      },
    });
    const hookId = makeHookKey("Stop", undefined, "notify");
    await disableHook({ scope: "user", hookId });

    const entries = await loadDisabledHooks();
    expect(entries).toHaveLength(1);
    expect(entries[0].hookId).toBe(hookId);
    expect(entries[0].scope).toBe("user");
    expect(entries[0].event).toBe("Stop");
    expect(entries[0].matcher).toBeUndefined();
    expect(entries[0].rawCommand).toEqual(sampleHook("notify"));
  });

  it("sidecar file is well-formed JSON", async () => {
    const { disableHook } = await loadModule();
    await writeJson(userSettings(), {
      hooks: { Stop: [{ hooks: [sampleHook("x")] }] },
    });
    await disableHook({ scope: "user", hookId: makeHookKey("Stop", undefined, "x") });

    const raw = await fs.readFile(sidecar(), "utf-8");
    const parsed = JSON.parse(raw) as { version: number; disabled: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.disabled).toHaveLength(1);
  });
});

describe("concurrent toggle serialization", () => {
  it("two parallel disables on same hookId serialize: exactly one succeeds, one fails with NOT_FOUND", async () => {
    // The settings file lock is FIFO per path. Once the first disable
    // removes the command and writes settings, the second call reads the
    // now-modified file and can't locate the command — NOT_FOUND. The
    // ALREADY_DISABLED branch covers a different scenario (sidecar pre-
    // populated before the call), tested separately.
    const { disableHook } = await loadModule();
    await writeJson(userSettings(), {
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [sampleHook("c1"), sampleHook("c2")] },
        ],
      },
    });
    const hookId = makeHookKey("PostToolUse", "Edit", "c1");

    const results = await Promise.allSettled([
      disableHook({ scope: "user", hookId }),
      disableHook({ scope: "user", hookId }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("configHistory snapshot", () => {
  it("records a pre-write snapshot when disabling", async () => {
    const { disableHook } = await loadModule();
    // configHistory writes manifest under tmpHome/.minder/config-history/
    // because it also reads os.homedir() at module load. Tests use the
    // same tmpHome.
    await writeJson(userSettings(), {
      hooks: { Stop: [{ hooks: [sampleHook("snap")] }] },
    });
    await disableHook({ scope: "user", hookId: makeHookKey("Stop", undefined, "snap") });

    const manifestPath = path.join(tmpHome, ".minder", "config-history", "manifest.jsonl");
    const exists = await fs
      .access(manifestPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
    const raw = await fs.readFile(manifestPath, "utf-8");
    expect(raw).toContain('"label":"hookToggle:disable"');
    expect(raw).toContain(userSettings().replace(/\\/g, "\\\\"));
  });
});
