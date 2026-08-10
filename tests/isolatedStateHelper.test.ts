import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { installIsolatedState, USAGE_CACHE_KEYS } from "./_helpers/isolatedState";

// Self-test for `tests/_helpers/isolatedState.ts` (issue #331).
//
// The helper's whole purpose is that its steps are load-bearing in ways that
// are invisible at the call site — so a test suite that only checked "the
// helper returns a path" would ratify nothing. Each case below is written to
// FAIL if a specific step is removed from the helper; the comment on each says
// which one. That is the mutation test in durable form, per the repo's
// working-practice note about tests that discriminate.

const state = installIsolatedState({
  prefix: "pm-selftest-",
  extraGlobals: USAGE_CACHE_KEYS,
  env: { MINDER_SELFTEST_FLAG: "1" },
});

/** Temp homes seen so far, so a later test can assert the earlier one is gone. */
const seenHomes: string[] = [];

describe("installIsolatedState", () => {
  it("points the DB path constant at the temp home, not the real one", async () => {
    // Discriminates: the home redirection as a whole. Without it `DB_DIR`
    // resolves against the developer's actual home — the silent leak the
    // helper exists to prevent, and one nothing else would report, since the
    // DB layer is built to degrade quietly.
    //
    // Note this does NOT isolate the `os.homedir()` spy: `HOME` /
    // `USERPROFILE` and the spy are deliberately redundant, and Node's
    // `os.homedir()` reads `USERPROFILE` on Windows and `$HOME` on POSIX
    // before asking the OS, so either mechanism alone would satisfy this
    // case. Removing the spy from the helper was measured to leave every
    // assertion in this file green. The case below covers the spy on its own.
    await state.reload();
    const { DB_DIR, DB_PATH } = await import("@/lib/db/connection");

    expect(DB_DIR).toBe(path.join(state.tmpHome(), ".minder"));
    expect(DB_PATH.startsWith(state.tmpHome())).toBe(true);

    // And the real home is genuinely elsewhere, so the assertion above isn't
    // passing because tmpdir happens to sit under it.
    const realHome = path.join(os.tmpdir(), "..");
    expect(DB_DIR.startsWith(path.join(realHome, ".minder"))).toBe(false);

    seenHomes.push(state.tmpHome());
  });

  it("keeps os.homedir() pinned even with HOME and USERPROFILE cleared", () => {
    // Discriminates: the `os.homedir()` spy specifically, by removing the
    // redundant mechanism first. Some modules call `os.homedir()` directly
    // rather than reading the environment, and a test is free to clear these
    // variables for its own reasons — the spy is what keeps those cases
    // pointed at the temp home. Teardown restores both from `savedEnv`.
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(os.homedir()).toBe(state.tmpHome());
  });

  it("gives the next test a different temp home and re-resolves the path", async () => {
    // Discriminates: `vi.resetModules()` inside `reload()`. Without it the
    // second dynamic import returns the cached module instance from the test
    // above, whose `DB_DIR` is frozen to the FIRST temp home — so this fails
    // on the equality check while still "looking isolated".
    expect(seenHomes).toHaveLength(1);
    expect(state.tmpHome()).not.toBe(seenHomes[0]);

    await state.reload();
    const { DB_DIR } = await import("@/lib/db/connection");
    expect(DB_DIR).toBe(path.join(state.tmpHome(), ".minder"));
  });

  it("removes the previous test's temp home", async () => {
    // Discriminates: the `fs.rm` in teardown. Leaked temp dirs are cheap
    // individually and expensive in aggregate — 30 files x N tests.
    expect(seenHomes).toHaveLength(1);
    expect(existsSync(seenHomes[0])).toBe(false);
    expect(existsSync(state.tmpHome())).toBe(true);
  });

  it("neutralises a MINDER_STATE_DIR set after setup ran", async () => {
    // Discriminates: the `delete process.env.MINDER_STATE_DIR` in `applyEnv()`,
    // which `reload()` re-applies. `DB_DIR` checks that variable BEFORE
    // `os.homedir()`, so anything that sets it outranks the spy and redirects
    // an "isolated" test at a real, possibly populated database.
    //
    // `tests/setup/clearStateDirEnv.ts` already deletes it once per file
    // (PR #332); this covers the case that setup file cannot — something
    // setting it while the suite is running.
    const intruder = path.join(os.tmpdir(), "pm-selftest-intruder");
    process.env.MINDER_STATE_DIR = intruder;
    try {
      await state.reload();
      const { DB_DIR } = await import("@/lib/db/connection");
      expect(DB_DIR).toBe(path.join(state.tmpHome(), ".minder"));
      expect(DB_DIR).not.toBe(intruder);
    } finally {
      delete process.env.MINDER_STATE_DIR;
    }
  });

  it("drops the cached DB handle and the declared extra caches", async () => {
    // Discriminates: `clearGlobals()`. `connection.ts` memoises its handle on
    // `globalThis` to survive HMR, so without this a reset module graph still
    // hands back the previous test's open database.
    const g = globalThis as Record<string, unknown>;
    g.__minderDb = { sentinel: true };
    for (const key of USAGE_CACHE_KEYS) g[key] = { sentinel: true };

    await state.reload();

    expect(g.__minderDb).toBeUndefined();
    for (const key of USAGE_CACHE_KEYS) expect(g[key]).toBeUndefined();
  });

  it("re-applies the isolation env on reload but not the caller's own", async () => {
    // Pins the distinction the helper draws. HOME / USERPROFILE / the
    // MINDER_STATE_DIR deletion are invariants and must survive a reload,
    // because a reload is when path constants get recaptured. A caller's `env`
    // value is ordinary setup, and a test is entitled to change it and reload
    // to watch the effect — `gradeSnapshot.test.ts` sets MINDER_USE_DB=0
    // mid-test for exactly that. An earlier draft re-applied both, silently
    // resetting the value and making that test assert a fallback that never
    // ran; this fails if that comes back.
    expect(process.env.MINDER_SELFTEST_FLAG).toBe("1");

    process.env.MINDER_SELFTEST_FLAG = "0";
    process.env.HOME = "somewhere-else";
    await state.reload();

    expect(process.env.MINDER_SELFTEST_FLAG).toBe("0");
    expect(process.env.HOME).toBe(state.tmpHome());
  });

  it("rejects MINDER_STATE_DIR as a caller option instead of silently dropping it", () => {
    // `reload()` re-applies the isolation invariant, which deletes this
    // variable — so an `env` override would hold through setup and vanish at
    // the reload every caller has to make, leaving the test exercising the
    // homedir fallback it was written to bypass. Failing loudly at install is
    // the only version of that a caller can notice (Codex review, PR #419).
    expect(() =>
      installIsolatedState({ prefix: "pm-reject-", env: { MINDER_STATE_DIR: "/tmp/x" } })
    ).toThrow(/MINDER_STATE_DIR cannot be set through `env`/);
  });

  it("restores environment variables it was asked to override", async () => {
    // Discriminates: the save/restore loop over `envKeys`. A file that sets
    // MINDER_USE_DB for its own cases must not hand that setting to the next
    // file in the same worker process.
    expect(process.env.HOME).toBe(state.tmpHome());
    expect(process.env.USERPROFILE).toBe(state.tmpHome());
    expect(process.env.MINDER_STATE_DIR).toBeUndefined();
    // Back to "1" — the previous test set it to "0" and teardown restored the
    // pre-test value, which setup then overwrote with the caller's again.
    expect(process.env.MINDER_SELFTEST_FLAG).toBe("1");
  });
});
