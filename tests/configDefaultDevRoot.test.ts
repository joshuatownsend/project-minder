import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { preserveEnvVars } from "./_helpers/preserveEnv";

// #481 — `DEFAULT_DEV_ROOT` used to be a module-scope `const`, so
// `probeDefaultDevRoot()` ran during IMPORT. Two things followed that no test
// could escape: the value was frozen before any `os.homedir()` spy was armed,
// and the default config — which `readConfig()` returns whenever no config file
// is found, i.e. every isolated test since #477 — carried it. Measured under
// full isolation at the time: state dir, adapters and hidden list all correctly
// isolated, `devRoot` still reading the real `C:\dev`.
//
// These tests drive the SEAM rather than the filesystem. Probing for real
// cannot discriminate the fix on this machine: `C:\dev` exists, so the probe
// returns exactly what the fallback would and the two answers coincide — which
// is precisely why the bug survived. Faking the platform module is what makes
// "resolved at import" and "resolved at call" tell apart.

const probeDefaultDevRoot = vi.fn<() => string | null>();
const getDefaultDevRoot = vi.fn<() => string>();

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return {
    ...actual,
    probeDefaultDevRoot: () => probeDefaultDevRoot(),
    getDefaultDevRoot: () => getDefaultDevRoot(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  getDefaultDevRoot.mockReturnValue("/fallback/dev");
});

describe("resolveDefaultDevRoot (#481)", () => {
  it("prefers a candidate that exists over the bare first choice", async () => {
    probeDefaultDevRoot.mockReturnValue("/home/me/dev");
    const { resolveDefaultDevRoot } = await import("@/lib/config");
    expect(resolveDefaultDevRoot()).toBe("/home/me/dev");
  });

  it("falls back to the first candidate when none exists", async () => {
    probeDefaultDevRoot.mockReturnValue(null);
    const { resolveDefaultDevRoot } = await import("@/lib/config");
    expect(resolveDefaultDevRoot()).toBe("/fallback/dev");
  });

  it("re-probes on every call rather than freezing at import", async () => {
    // The whole point. As a module-scope const the second answer here would be
    // the first one, because the probe would have run once during import.
    probeDefaultDevRoot.mockReturnValue("/first/dev");
    const { resolveDefaultDevRoot } = await import("@/lib/config");
    expect(resolveDefaultDevRoot()).toBe("/first/dev");

    probeDefaultDevRoot.mockReturnValue("/second/dev");
    expect(resolveDefaultDevRoot()).toBe("/second/dev");
    expect(probeDefaultDevRoot).toHaveBeenCalledTimes(2);
  });

  it("does not probe at import time at all", async () => {
    probeDefaultDevRoot.mockReturnValue("/first/dev");
    await import("@/lib/config");
    expect(probeDefaultDevRoot).not.toHaveBeenCalled();
  });
});

describe("readConfig default devRoot (#481)", () => {
  it("resolves devRoot when the config is read, not when the module loads", async () => {
    // `readConfig()` falls back to the defaults whenever no `.minder.json` is
    // found, which is the path every isolated test takes. Under the old const
    // that default carried a value probed against the developer's real home.
    probeDefaultDevRoot.mockReturnValue("/at/read/time");
    const { readConfig } = await import("@/lib/config");
    const cfg = await readConfig();
    expect(cfg.devRoot).toBe("/at/read/time");
    expect(probeDefaultDevRoot).toHaveBeenCalled();
  });

  it("hands each caller its own defaults object", async () => {
    // The defaults are built per call now instead of being one shared const.
    // Callers already spread it, so nothing depended on identity — but a
    // shared object would also share a stale `devRoot`.
    probeDefaultDevRoot.mockReturnValue("/a/dev");
    const { readConfig } = await import("@/lib/config");
    const first = await readConfig();
    expect(first.devRoot).toBe("/a/dev");
    first.hidden.push("mutated-by-a-caller");

    // Past the 3s config cache, a fresh read must not see that mutation.
    vi.resetModules();
    probeDefaultDevRoot.mockReturnValue("/b/dev");
    const again = await import("@/lib/config");
    const second = await again.readConfig();
    expect(second.devRoot).toBe("/b/dev");
    expect(second.hidden).toEqual([]);
  });
});

describe("getDevRoots (#481)", () => {
  it("falls back to the resolved default when devRoot is empty", async () => {
    probeDefaultDevRoot.mockReturnValue("/resolved/dev");
    const { getDevRoots } = await import("@/lib/config");
    expect(
      getDevRoots({
        statuses: {},
        hidden: [],
        portOverrides: {},
        devRoot: "",
        pinnedSlugs: [],
      })
    ).toEqual(["/resolved/dev"]);
  });

  it("prefers an explicit devRoots list and never probes", async () => {
    probeDefaultDevRoot.mockReturnValue("/resolved/dev");
    const { getDevRoots } = await import("@/lib/config");
    expect(
      getDevRoots({
        statuses: {},
        hidden: [],
        portOverrides: {},
        devRoot: "C:\\dev",
        devRoots: ["/one", "/two"],
        pinnedSlugs: [],
      })
    ).toEqual(["/one", "/two"]);
    expect(probeDefaultDevRoot).not.toHaveBeenCalled();
  });
});

describe("readConfig applies the substrate invariant (#491, Codex P1 on #509)", () => {
  // Several consumers read `config.enabledAdapters` RAW and never touch the
  // adapter registry — `server/queries/sessions.ts` builds its filter set from
  // it directly, so a config saved as ["codex"] by the old UI would strip every
  // Claude session out of /api/sessions while Settings said "Always on".
  // Normalising inside `getEnabledAdapters` alone does not reach them.
  // The global `isolateStateDir` setup pins MINDER_STATE_DIR per fork; these
  // tests repoint it at a config file they wrote, so they have to put it back.
  // Caught by `dbIsolationGuard` rather than by review — which is the point of
  // the rule this session added in #421.
  preserveEnvVars(["MINDER_STATE_DIR"]);

  async function withConfigFile(contents: unknown) {
    // mkdtemp, not a fixed name: a shared path would collide with another fork
    // running this file's siblings, and the failure would look like a flake.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cfg-invariant-"));
    await fs.writeFile(
      path.join(tmp, ".minder.json"),
      JSON.stringify(contents),
      "utf-8"
    );
    process.env.MINDER_STATE_DIR = tmp;
    vi.resetModules();
    return (await import("@/lib/config")).readConfig;
  }

  it("adds claude to a stored list that omits it", async () => {
    const readConfig = await withConfigFile({ enabledAdapters: ["codex"] });
    expect((await readConfig()).enabledAdapters).toEqual(["claude", "codex"]);
  });

  it("leaves a list that already has it exactly as stored", async () => {
    const readConfig = await withConfigFile({ enabledAdapters: ["codex", "claude"] });
    expect((await readConfig()).enabledAdapters).toEqual(["codex", "claude"]);
  });

  it("leaves the field ABSENT when the config never set it", async () => {
    // Every consumer already defaults `undefined` to ["claude"], so
    // materialising the field would change what a config reports without
    // changing what it means.
    const readConfig = await withConfigFile({ devRoot: "/x" });
    expect((await readConfig()).enabledAdapters).toBeUndefined();
  });
});
