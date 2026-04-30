// Project Minder ingest worker entry point.
//
// Lives at the project root (NOT under src/) so Next.js / Turbopack
// don't try to bundle it. Plain .mjs ESM so Node can `new Worker()` it
// directly — no compilation step, no loader hook needed for this shim.

import { parentPort } from "node:worker_threads";

if (!parentPort) {
  // Defensive: if this module is somehow loaded as a top-level script
  // (e.g. someone runs `node workers/ingestWorker.mjs` by hand), exit
  // cleanly instead of throwing on `parentPort.on`.
  process.exit(0);
}

parentPort.postMessage({ type: "ready", at: Date.now() });

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "ping":
      parentPort.postMessage({ type: "pong", echo: msg.payload ?? null, at: Date.now() });
      return;
    case "crash-test":
      throw new Error("crash-test: synthetic worker crash");
    case "stop":
      parentPort.postMessage({ type: "stopping", at: Date.now() });
      process.exit(0);
      return;
    default:
      parentPort.postMessage({ type: "unknown", received: msg });
  }
});
