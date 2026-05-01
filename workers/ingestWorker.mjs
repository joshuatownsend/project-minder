// Project Minder ingest worker entry point.
//
// Lives at the project root (NOT under src/) so Next.js / Turbopack
// don't try to bundle it. Plain .mjs ESM that Node loads directly.
// The watcher implementation is built ahead of time by
// `scripts/build-worker.mjs` into `workers/dist/ingestWorker.mjs`
// (esbuild bundle: TS stripped, path aliases resolved, `server-only`
// neutralized, `better-sqlite3` and `chokidar` left external). The
// `predev` and `prebuild` npm scripts run the build before Next.js
// starts so the bundle is always fresh.

import { parentPort } from "node:worker_threads";

if (!parentPort) {
  // Defensive: if this module is somehow loaded as a top-level script
  // (e.g. someone runs `node workers/ingestWorker.mjs` by hand), exit
  // cleanly instead of throwing on `parentPort.on`.
  process.exit(0);
}

const errorMessage = (e) => (e instanceof Error ? e.message : String(e));

let watcher = null;
let watcherLoadError = null;
let started = false;

try {
  watcher = await import("./dist/ingestWorker.mjs");
} catch (err) {
  watcherLoadError = errorMessage(err);
}

parentPort.postMessage({
  type: "ready",
  at: Date.now(),
  ...(watcherLoadError ? { watcherLoadError } : {}),
});

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  // Wrap the async dispatch so an uncaught throw inside a handler
  // surfaces as a structured error message back to the host instead
  // of an unhandled promise rejection that would crash the worker.
  void handleMessage(msg).catch((err) => {
    parentPort.postMessage({
      type: "error",
      phase: "message",
      error: errorMessage(err),
      at: Date.now(),
    });
  });
});

async function handleMessage(msg) {
  switch (msg.type) {
    case "start":
      await handleStart(msg.options ?? {});
      return;
    case "stop":
      await handleStop();
      return;
    case "status":
      handleStatus();
      return;
    case "ping":
      // Kept for parity with phase-1 lifecycle tests.
      parentPort.postMessage({ type: "pong", echo: msg.payload ?? null, at: Date.now() });
      return;
    case "crash-test":
      throw new Error("crash-test: synthetic worker crash");
    default:
      parentPort.postMessage({ type: "unknown", received: msg });
  }
}

async function handleStart(options) {
  if (started) {
    parentPort.postMessage({ type: "started", at: Date.now(), alreadyRunning: true });
    return;
  }
  if (!watcher) {
    parentPort.postMessage({
      type: "error",
      phase: "start",
      error: watcherLoadError ?? "watcher module not loaded",
      at: Date.now(),
    });
    return;
  }
  try {
    const status = await watcher.startIngestWatcher({
      ...options,
      // The host has already gated on env flags; don't double-check.
      bypassEnvFlag: true,
    });
    // Only mark started if the watcher actually entered a running
    // state. With `running: false` (e.g. DB driver unavailable, the
    // watcher returned an idle status), ingest is NOT live — surface
    // it as a start error so the host can fall back to the in-process
    // path rather than think everything is fine.
    if (status?.running === true) {
      started = true;
      parentPort.postMessage({ type: "started", at: Date.now(), status });
      return;
    }
    parentPort.postMessage({
      type: "error",
      phase: "start",
      error: "watcher did not enter a running state",
      status,
      at: Date.now(),
    });
  } catch (err) {
    parentPort.postMessage({
      type: "error",
      phase: "start",
      error: errorMessage(err),
      at: Date.now(),
    });
  }
}

async function handleStop() {
  try {
    if (started && watcher) {
      await watcher.stopIngestWatcher();
      started = false;
    }
  } catch {
    /* swallow — we're tearing down anyway */
  }
  parentPort.postMessage({ type: "stopping", at: Date.now() });
  process.exit(0);
}

function handleStatus() {
  if (!watcher || !started) {
    parentPort.postMessage({ type: "status", at: Date.now(), running: false });
    return;
  }
  try {
    const status = watcher.getWatcherStatus();
    parentPort.postMessage({ type: "status", at: Date.now(), ...status });
  } catch (err) {
    parentPort.postMessage({
      type: "error",
      phase: "status",
      error: errorMessage(err),
      at: Date.now(),
    });
  }
}
