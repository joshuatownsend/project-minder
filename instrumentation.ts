// Next.js instrumentation hook. Runs once per server process at startup
// and is invoked by Next.js for **both** the Node and Edge runtimes
// regardless of where our actual logic needs to run.
//
// All Node-only work — the SQLite indexer worker, the chokidar watcher,
// every `fs` / `process.cwd` / `child_process` call in their import
// graph — lives in `instrumentation-node.ts`. That sibling file imports
// `'server-only'` at the top, which Turbopack treats as a hard "do not
// compile for the Edge runtime" signal. Coupled with our runtime gate
// below, the Edge-runtime build never traces the Node module graph and
// we don't get spammed with "Node.js API used in Edge Runtime"
// warnings on every dev startup.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Vitest sets NODE_ENV=test. Do not start any ingest path in test
  // contexts — both the worker and the in-process watcher have their
  // own NODE_ENV gates, but we short-circuit here so a stray
  // instrumentation load (e.g. via dynamic-import in a test) never
  // races against tmpHome fixtures.
  if (process.env.NODE_ENV === "test") return;

  const { startIngest } = await import("./instrumentation-node");
  await startIngest();
}
