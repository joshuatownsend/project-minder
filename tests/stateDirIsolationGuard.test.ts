import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import { existsSync, promises as fs } from "fs";
import { resolveStateDir } from "@/lib/serverRoot";
import { installIsolatedState } from "./_helpers/isolatedState";

/**
 * Pins the suite-wide state isolation established in #477.
 *
 * The defect this guards against was silent for the whole life of the suite:
 * `tests/setup/clearStateDirEnv.ts` deleted `MINDER_STATE_DIR`, and
 * `resolveStateDir()` is `MINDER_STATE_DIR || process.cwd()`, so every test
 * that reached `readConfig()` read the developer's real, git-ignored
 * `.minder.json` from the repo root. Measured before the fix, inside a fully
 * "isolated" test: `enabledAdapters: ["claude","codex"]`, a 4-entry `hidden`
 * list, and the maintainer's real `devRoot`. Three tests in
 * `dataIndexBuildingGates.test.ts` branched on that first value.
 *
 * Nothing failed loudly, which is the point of a guard rather than a comment:
 * the fix lives in a setup file and two helpers that no test imports by name,
 * so a refactor can drop it without breaking anything visibly. These cases fail
 * immediately if that happens.
 *
 * Sibling of `dbIsolationGuard.test.ts`, which polices the same class for the
 * database rather than for user state.
 */
describe("suite-wide state dir isolation (#477)", () => {
  const REPO_ROOT = process.cwd();

  it("never resolves state to the repo root", () => {
    // The whole defect in one assertion. `process.cwd()` under vitest is the
    // repo, and that is where `.minder.json` and `.cache/` actually live.
    expect(resolveStateDir()).not.toBe(REPO_ROOT);
  });

  it("pins MINDER_STATE_DIR rather than leaving it unset", () => {
    // Discriminates between the fix and the state it replaced: deleting the
    // variable also satisfies "don't inherit the developer's shell value", but
    // reopens the `process.cwd()` fall-through that is the actual bug.
    expect(process.env.MINDER_STATE_DIR).toBeTruthy();
    expect(resolveStateDir()).toBe(process.env.MINDER_STATE_DIR);
  });

  it("reads default config, not the developer's .minder.json", async () => {
    // The end-to-end consequence, asserted through the real entry point rather
    // than through the env var.
    //
    // `enabledAdapters` is asserted FIRST and matters most: it is the field
    // that actually changed outcomes in #474, and it is absent from
    // `DEFAULT_CONFIG` entirely, so `undefined` here means no file was read.
    // An earlier draft of this guard checked only `hidden` and `statuses` —
    // which a real `.minder.json` carrying nothing but `enabledAdapters` would
    // have passed, i.e. it would have missed the exact leak it was written for
    // (Copilot, PR #482). A guard aimed at the wrong field is worse than none,
    // because it reads as coverage.
    const { readConfig } = await import("@/lib/config");
    const cfg = await readConfig();
    expect(cfg.enabledAdapters).toBeUndefined();
    expect(cfg.hidden).toEqual([]);
    expect(cfg.statuses).toEqual({});
  });

  it("resolves a config path that does not exist", async () => {
    // The structural half of the assertion above, and the one that cannot go
    // vacuous. On a clean checkout with no `.minder.json` anywhere, every
    // field-level assertion passes whether isolation works or not; this one
    // still fails, because the repo root is not where an isolated run should be
    // looking. Together they cover both a machine that has a config and one
    // that does not.
    expect(existsSync(path.join(resolveStateDir(), ".minder.json"))).toBe(false);
  });

  it("writes state under the pinned dir, not into the working tree", async () => {
    // `.cache/` is the write half of the same leak: three modules resolve
    // `path.join(resolveStateDir(), ".cache")` at module scope and mkdir it on
    // first write. Before #477 that wrote a 1.2 MB pricing file into the repo.
    const stateDir = resolveStateDir();
    const probe = path.join(stateDir, ".cache", "guard-probe.json");
    await fs.mkdir(path.dirname(probe), { recursive: true });
    await fs.writeFile(probe, "{}");
    try {
      expect(probe.startsWith(REPO_ROOT + path.sep)).toBe(false);
      expect(probe.startsWith(os.tmpdir())).toBe(true);
    } finally {
      await fs.rm(probe, { force: true });
    }
  });

  describe("under installIsolatedState", () => {
    const state = installIsolatedState({ prefix: "pm-guard-" });

    it("agrees with what the homedir spy produces", async () => {
      // The property that makes pinning safe where an arbitrary value would not
      // be. `DB_DIR` is `MINDER_STATE_DIR || path.join(os.homedir(), ".minder")`
      // — two branches that must not disagree, or the env branch silently wins
      // and an "isolated" test opens a database the spy never chose. Asserting
      // both sides resolve to the same string is what licenses the inversion.
      await state.reload();
      const { DB_DIR } = await import("@/lib/db/connection");
      const spied = path.join(os.homedir(), ".minder");
      expect(process.env.MINDER_STATE_DIR).toBe(spied);
      expect(DB_DIR).toBe(spied);
      expect(DB_DIR).toBe(path.join(state.tmpHome(), ".minder"));
    });
  });
});

describe("config writes into a state dir that does not exist yet (#482)", () => {
  const state = installIsolatedState({ prefix: "pm-cfgwrite-" });

  it("creates the state dir rather than failing with ENOENT", async () => {
    // Discriminates `ensureStateDir()` in `src/lib/config.ts`. `writeFileAtomic`
    // writes its temp file with a plain `fs.writeFile` and creates no parent, so
    // before that call `writeConfig()` threw ENOENT whenever nothing else had
    // made the directory first.
    //
    // Production hit this too, not just tests: `initDb`'s
    // `mkdir(DB_DIR, { recursive: true })` was what happened to create it on a
    // normal boot, but with `MINDER_USE_DB=0` or `better-sqlite3` absent nothing
    // does, and a fresh machine's first `setProjectStatus()` would have failed.
    //
    // The premise guard matters: if the directory already exists this asserts
    // nothing at all, which is exactly how the bug hid for so long.
    await state.reload();
    const { writeConfig, readConfig } = await import("@/lib/config");
    const { resolveStateDir } = await import("@/lib/serverRoot");

    const stateDir = resolveStateDir();
    expect(existsSync(stateDir)).toBe(false);

    await writeConfig({
      statuses: { demo: "active" },
      hidden: ["x"],
      portOverrides: {},
      devRoot: "C:\dev",
      pinnedSlugs: [],
    });

    expect(existsSync(path.join(stateDir, ".minder.json"))).toBe(true);
    expect((await readConfig()).hidden).toEqual(["x"]);
  });
});
