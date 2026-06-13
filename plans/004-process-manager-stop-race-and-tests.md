# Plan 004: Make dev-server stop/restart deterministic, and add the missing tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1b45d2b..HEAD -- src/lib/processManager.ts src/lib/platform.ts src/lib/tasks/emergencyStop.ts "src/app/api/dev-server/[slug]/route.ts"`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts below against the live code before editing; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / tests
- **Planned at**: commit `1b45d2b`, 2026-06-13

## Why this matters

The dev-server process manager kills processes **fire-and-forget** and `restart()` hopes a
fixed 2-second sleep is long enough for the old process tree to die before the new one
binds the port. On a slow machine or a heavy process tree, the old process is still holding
the port when `start()` runs, so `start()`'s own in-use check returns an `errored`
`DevServerInfo` ("Port N is already in use") — a spurious failure the user sees as "restart
didn't work." The root cause is that `killProcessTree` returns `void` (it spawns `taskkill`
and returns immediately), so `stop()` and `restart()` have no way to wait for actual death.
`processManager.ts` also has **zero test coverage** despite encoding a start/stop/restart
state machine and port-detection logic. This plan makes the kill awaitable, replaces the
blind sleep with a bounded poll on the actual port, and adds the missing tests.

## Current state

### `killProcessTree` returns void (`src/lib/platform.ts:86–105`)

```ts
export function killProcessTree(pid: number): void {
  if (isWindows) {
    const taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
    });
    taskkill.on("error", () => {
      try { process.kill(pid); } catch { /* already exited */ }
    });
    return;                       // ← returns before taskkill finishes
  }
  try { process.kill(-pid, "SIGTERM"); } catch { /* already exited */ }
}
```

Callers of `killProcessTree`: `src/lib/processManager.ts:148` and
`src/lib/tasks/emergencyStop.ts:55`.

### `stop()` is sync; `restart()` blind-sleeps (`src/lib/processManager.ts:141–161`)

```ts
  stop(slug: string): DevServerInfo | undefined {
    const entry = this.processes.get(slug);
    if (!entry) return undefined;
    const { proc, info } = entry;
    if (proc.exitCode === null && proc.pid) {
      killProcessTree(proc.pid);          // ← not awaited
    }
    info.status = "stopped";
    info.output.push("--- Server stopped ---");
    return info;
  }

  async restart(slug: string, projectPath: string, portOverride?: number): Promise<DevServerInfo> {
    this.stop(slug);
    await new Promise((resolve) => setTimeout(resolve, 2000));  // ← blind sleep
    this.processes.delete(slug);
    return this.start(slug, projectPath, portOverride);
  }
```

### `start()` already errors when the port is in use (`src/lib/processManager.ts:60–74`)

```ts
    if (port) {
      const inUse = await isPortInUse(port);
      if (inUse) {
        return { /* ...status: "errored", output: [`Port ${port} is already in use.`] */ };
      }
    }
```

So the race surfaces as a spurious "Port N is already in use" error on `restart`.
`isPortInUse(port: number): Promise<boolean>` is a module-local helper in
`processManager.ts` (used at line 62) and `DevServerInfo.port` is set on the running
process's `info`.

### The one sync `stop()` caller (`src/app/api/dev-server/[slug]/route.ts:66`)

```ts
      case "stop": {
        const info = processManager.stop(slug);     // ← inside an async POST handler
        return NextResponse.json(info || { status: "stopped", slug });
      }
```

### Convention

`processManager.ts` already uses `async`/`await` throughout (`start`, `restart`,
`detectDevCommand`). There is no `tests/processManager.test.ts`. Module-mocking pattern in
this repo: `vi.mock("@/lib/...")` returning stubs (see `tests/scannerFeatureFlags.test.ts`,
`tests/gitStatusCacheDispose.test.ts`).

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                     | exit 0              |
| Tests     | `pnpm test -- processManager`        | new file passes     |
| Full test | `pnpm test`                          | all pass            |
| Lint      | `pnpm lint`                          | exit 0              |

## Scope

**In scope** (the only files you should modify/create):
- `src/lib/platform.ts` — make `killProcessTree` awaitable.
- `src/lib/processManager.ts` — `stop()` async + await kill; `restart()` bounded port poll.
- `src/lib/tasks/emergencyStop.ts` — update the `killProcessTree` call for the new signature.
- `src/app/api/dev-server/[slug]/route.ts` — `await` the now-async `stop()`.
- `tests/processManager.test.ts` (create).

**Out of scope** (do NOT touch):
- The 2000ms "did it crash on boot?" sleep in `start()` (line ~132) — that's a separate
  startup heuristic, not the restart race. Leave it.
- `spawnDevServer`, `getBinPath`, `getCleanSpawnEnv` in `platform.ts`.
- `detectDevCommand`'s detection logic (you'll TEST it, not change it).
- The `findFreePort` export and the worktrees route.

## Git workflow

- Branch: `advisor/004-devserver-stop-race`.
- Commit style: Conventional Commits (e.g. `fix(devserver): await process kill and poll port on restart`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make `killProcessTree` awaitable

In `src/lib/platform.ts`, change `killProcessTree` to return `Promise<void>` that resolves
when the kill completes:

```ts
export function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (isWindows) {
      const taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      taskkill.on("error", () => {
        try { process.kill(pid); } catch { /* already exited */ }
        resolve();
      });
      taskkill.on("close", () => resolve());
      return;
    }
    try { process.kill(-pid, "SIGTERM"); } catch { /* already exited */ }
    resolve();
  });
}
```

**Verify**: `pnpm typecheck` → fails only at the two call sites (next steps). That's expected.

### Step 2: Update `emergencyStop.ts` for the new signature

Open `src/lib/tasks/emergencyStop.ts` around line 55. If the enclosing function is `async`,
change `killProcessTree(pid);` to `await killProcessTree(pid);`. If it is **not** async and
making it async would ripple, instead write `void killProcessTree(pid);` to mark the
fire-and-forget intentional (and silence the floating-promise lint). Pick whichever keeps
`pnpm typecheck` and `pnpm lint` green with the smallest change; note your choice in the report.

**Verify**: `pnpm lint` → no floating-promise error for that line.

### Step 3: Make `stop()` async and await the kill

In `src/lib/processManager.ts`:

```ts
  async stop(slug: string): Promise<DevServerInfo | undefined> {
    const entry = this.processes.get(slug);
    if (!entry) return undefined;
    const { proc, info } = entry;
    if (proc.exitCode === null && proc.pid) {
      await killProcessTree(proc.pid);
    }
    info.status = "stopped";
    info.output.push("--- Server stopped ---");
    return info;
  }
```

**Verify**: `pnpm typecheck` → fails only at the route caller (Step 5). Expected.

### Step 4: Replace the blind sleep in `restart()` with a bounded port poll

```ts
  async restart(slug: string, projectPath: string, portOverride?: number): Promise<DevServerInfo> {
    const prevPort = this.processes.get(slug)?.info.port;
    await this.stop(slug);
    // Wait for the OS to release the port the old process held, instead of a
    // blind fixed sleep. Bounded so a stuck port can't hang the request.
    const targetPort = portOverride ?? prevPort;
    if (targetPort) {
      const deadlineMs = 5000;
      const stepMs = 200;
      let waited = 0;
      while (waited < deadlineMs && (await isPortInUse(targetPort))) {
        await new Promise((r) => setTimeout(r, stepMs));
        waited += stepMs;
      }
    }
    this.processes.delete(slug);
    return this.start(slug, projectPath, portOverride);
  }
```

If `targetPort` is undefined (port unknown), `start()` still runs — it has its own checks.

**Verify**: `pnpm typecheck` → exit 0 after Step 5; `pnpm lint` → exit 0.

### Step 5: Await `stop()` at the API route caller

In `src/app/api/dev-server/[slug]/route.ts` (line ~66):

```ts
      case "stop": {
        const info = await processManager.stop(slug);
        return NextResponse.json(info || { status: "stopped", slug });
      }
```

(It's already inside an `async function POST`.)

**Verify**: `pnpm typecheck` → exit 0.

### Step 6: Create `tests/processManager.test.ts`

Mock `@/lib/platform` so no real processes spawn. The module exports a `processManager`
singleton (instance of an unexported class) — test through that singleton, resetting state
between tests (`processManager.getAll()` then stop each, or re-import fresh with
`vi.resetModules()` per test).

Required cases:

1. **`detectDevCommand` port parsing** (pure-ish; mock `fs.readFile` to return a
   `package.json` JSON string). Cover: a `dev` script with `--port 4100` → port 4100;
   a script with `PORT=3001` → 3001; a `next` script with no port → 3000 (the default in
   `detectDevCommand`). `detectDevCommand` is private — exercise it indirectly via `start()`
   with `spawnDevServer`/`isPortInUse` mocked, OR (preferred) export `detectDevCommand` for
   testing only if it's currently private and that's the lowest-friction path; if you export
   it, keep it a named export and note it. If exporting is undesirable, drive it through
   `start()` and assert the resulting `info.port`/`info.command`.

2. **`stop()` awaits the kill**: mock `killProcessTree` as a `vi.fn()` returning a
   deferred promise; start a fake "running" entry (inject one into the manager via `start()`
   with mocked `spawnDevServer` returning a fake `ChildProcess` whose `exitCode` is `null`
   and `pid` is set). Call `stop(slug)`, assert `killProcessTree` was called with the pid,
   and that the returned promise does not resolve until the deferred kill resolves
   (resolve the deferred, then assert `info.status === "stopped"`).

3. **`restart()` waits for the port to free**: mock `isPortInUse` to return `true` twice
   then `false`; mock `killProcessTree` resolved; spy that `start()` is not reached until
   `isPortInUse` returns `false`. Assert the final returned info is not the "Port … in use"
   errored shape. (Use fake timers — `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` —
   to drive the 200ms poll without real waiting; restore with `vi.useRealTimers()`.) If
   wiring fake timers through the poll proves too fiddly, mark this case `it.todo` and cover
   it in a follow-up — cases 1 and 2 are the required minimum for done-criteria.

For the fake `ChildProcess`, a minimal stub suffices: an `EventEmitter`-like object with
`pid`, `exitCode`, `stdout`/`stderr` as `EventEmitter`s (or objects with `.on`), and `on`.

**Verify**: `pnpm test -- processManager` → cases 1 and 2 pass (case 3 passes or is `it.todo`).

### Step 7: Full verification

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass; `pnpm lint` → exit 0.

## Test plan

- New `tests/processManager.test.ts`: (1) `detectDevCommand` port parsing for next/--port/PORT=,
  (2) `stop()` resolves only after `killProcessTree` resolves and sets status "stopped",
  (3) `restart()` polls `isPortInUse` until free before starting (or `it.todo`).
- Mock `@/lib/platform` (spawn/kill) and `fs` (package.json reads). No real child processes.
- Pattern reference: `tests/scannerFeatureFlags.test.ts` for `vi.mock`; vitest fake timers
  for the poll.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; `tests/processManager.test.ts` exists with cases 1 and 2 passing
- [ ] `pnpm lint` exits 0 (no floating-promise warning at the `killProcessTree`/`stop` sites)
- [ ] `killProcessTree` returns `Promise<void>` and is awaited in `processManager.stop`
- [ ] `restart()` no longer contains the literal `setTimeout(resolve, 2000)` blind sleep
      (`grep -n "2000" src/lib/processManager.ts` → only the unrelated start() boot sleep, if any)
- [ ] The API route `stop` case awaits `processManager.stop`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The "Current state" excerpts don't match the live code (drift since `1b45d2b`).
- `killProcessTree` has callers beyond `processManager.ts:148` and `emergencyStop.ts:55`
  (re-run `grep -rn "killProcessTree" src/`) — each additional caller needs the same await/void treatment.
- `isPortInUse` is not defined in `processManager.ts` (the restart poll relies on it).
- Exporting `detectDevCommand` for testing conflicts with a lint rule and driving it through
  `start()` also proves intractable — report and ship cases 2 and 3 only.

## Maintenance notes

- The 5000ms restart deadline is a safety cap, not a guarantee; if a port is held by an
  unrelated process, `start()` still returns its normal "in use" error after the poll — that's
  correct behavior, not a regression.
- If `killProcessTree` is ever used in a hot loop, the per-call `taskkill` spawn cost matters;
  not a concern at current call volume.
- Reviewer should scrutinize: that `stop()`'s status mutation still happens after the await
  (not before), and that no caller treats `stop()`'s now-Promise return as a sync value.
- Deferred: verifying the process is *actually* dead (not just the port freed) via PID
  liveness — out of scope; port-free is the practical signal for restart.
