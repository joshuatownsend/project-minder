import { describe, it, expect, beforeEach, vi } from "vitest";
import { preserveEnvVars } from "./_helpers/preserveEnv";

// #296 — with `MINDER_BOOTSTRAP=0` a service shutdown ran ~0 disposers.
//
// Since #294 the OS signal handlers install independently of the collectors
// opt-out, precisely so a sidecar launched with collectors off still stops
// cleanly. But the disposers those handlers fire were registered only inside
// `runBootstrap()`, which that flag turns off. So the process exited 0 without
// stopping dispatcher ticks, draining ingest, or checkpointing the WAL — a
// clean EXIT rather than a clean SHUTDOWN. (better-sqlite3 recovers its WAL on
// the next boot, so no corruption; that is why this was a P2 and not a P1.)
//
// The subsystems in question start independently of the bootstrap gate, which
// is what makes the mismatch a real one rather than a tidy-up.

const onShutdown = vi.fn();
const installSignalHandlers = vi.fn();
const initControlChannel = vi.fn();

vi.mock("@/lib/lifecycle", () => ({
  onShutdown: (...a: unknown[]) => onShutdown(...a),
  installSignalHandlers: () => installSignalHandlers(),
}));
vi.mock("@/lib/controlChannel", () => ({
  initControlChannel: () => initControlChannel(),
}));

// `installServiceLifecycle` returns early under vitest so the runner keeps its
// own SIGINT and stdin. These tests are about that function, so they lift the
// guard for their own scope and put it back — the `delete` that #421 made the
// suite's guard reject unless the original is restored.
preserveEnvVars(["VITEST", "MINDER_BOOTSTRAP", "MINDER_CONTROL_STDIN", "NODE_ENV"]);

/** The disposers that must exist for a shutdown to be a shutdown. */
const REQUIRED = [
  "sqlite",
  "tasksDb",
  "dispatcher",
  "gitStatusCache",
  "githubActivityCache",
  "manualStepsWatcher",
  "mcpConfigWatcher",
];

async function installUnderCollectorsOff() {
  const mod = await import("@/lib/bootstrap");
  mod._resetBootstrapForTesting();
  delete process.env.VITEST;
  // The exact configuration from the issue: a supervisor asking for the
  // control channel, with collectors explicitly OFF.
  process.env.MINDER_BOOTSTRAP = "0";
  process.env.MINDER_CONTROL_STDIN = "1";
  await mod.installServiceLifecycle();
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("service lifecycle registers disposers independently of MINDER_BOOTSTRAP (#296)", () => {
  it("registers every shutdown disposer with collectors off", async () => {
    await installUnderCollectorsOff();
    const registered = onShutdown.mock.calls.map((c) => c[0] as string);
    for (const name of REQUIRED) expect(registered).toContain(name);
  });

  it("registers them BEFORE installing the signal handlers", async () => {
    // A stop arriving in the window between the two would otherwise find an
    // empty registry — the same failure, just narrower.
    await installUnderCollectorsOff();
    expect(onShutdown).toHaveBeenCalled();
    expect(installSignalHandlers).toHaveBeenCalled();
    const lastRegister = onShutdown.mock.invocationCallOrder.at(-1)!;
    const install = installSignalHandlers.mock.invocationCallOrder[0];
    expect(lastRegister).toBeLessThan(install);
  });

  it("reports the lifecycle as installed, which is what gates the ingest disposer", async () => {
    // `instrumentation-node`'s `registerIngestDisposer` used to ask
    // `getBootstrapStatus().ran` — false here — and so skipped the disposer
    // for the ingest pipeline it was about to start.
    const mod = await installUnderCollectorsOff();
    expect(mod.isServiceLifecycleInstalled()).toBe(true);
    expect(mod.getBootstrapStatus().ran).toBe(false);
  });

  it("installs nothing when the gate is closed", async () => {
    // Plain `next dev`: no collectors, no supervisor. Nothing can fire a
    // disposer, so nothing should be registered.
    const mod = await import("@/lib/bootstrap");
    mod._resetBootstrapForTesting();
    delete process.env.VITEST;
    process.env.MINDER_BOOTSTRAP = "0";
    delete process.env.MINDER_CONTROL_STDIN;
    // NODE_ENV is typed readonly; `shouldBootstrap` only reads it, and the
    // runner already sets "test", which is neither "production" nor an
    // explicit opt-in — so the gate is closed without touching it.
    expect(process.env.NODE_ENV).not.toBe("production");

    await mod.installServiceLifecycle();

    expect(onShutdown).not.toHaveBeenCalled();
    expect(installSignalHandlers).not.toHaveBeenCalled();
    expect(mod.isServiceLifecycleInstalled()).toBe(false);
  });
});
