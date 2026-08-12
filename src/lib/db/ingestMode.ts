/**
 * Which ingest mode `startIngest()` should use, given the environment.
 *
 * Pure and separately testable on purpose: three flags interact here, and two
 * of the interactions were live bugs caught in review of #431 (PR #435) rather
 * than anything a single-flag reading would surface.
 *
 *   - `MINDER_INDEXER=0` means "no automatic index updates". It must beat the
 *     packaged worker default, because the worker starts its watcher with
 *     `bypassEnvFlag: true` (workers/ingestWorker.mjs) — which deliberately
 *     skips the `MINDER_INDEXER === "0"` guard in `ingestWatcher.ts`. Default
 *     the worker on without checking, and an operator who disabled ingest gets
 *     it back, silently.
 *
 *   - `MINDER_PACKAGED=1` is stamped into the generated `server.js` by
 *     `scripts/package-standalone.mjs`. The packaged/source distinction is
 *     known there, but the DECISION is made here, because this runs after Next
 *     has loaded `.env` files. Deciding in the wrapper would set
 *     `MINDER_INDEXER_WORKER` before those files load, and Next never
 *     overwrites an existing `process.env` value — so a `.env.local` opt-out
 *     would be masked by the very default it is trying to disable.
 *
 * An explicit `MINDER_INDEXER_WORKER=1` still forces worker mode from a source
 * checkout, where it stays opt-in.
 */
export type IngestMode = "worker" | "in-process" | "off";

/**
 * `Partial<NodeJS.ProcessEnv>` rather than `NodeJS.ProcessEnv`: the latter
 * requires `NODE_ENV`, so every test case would have to carry an unrelated
 * field just to name three flags. A hand-rolled interface of only those three
 * doesn't work either — with no declared property in common with `ProcessEnv`
 * it trips TypeScript's weak-type detection (TS2559). Partial keeps the index
 * signature, so both `process.env` and a bare `{ MINDER_PACKAGED: "1" }`
 * satisfy it.
 */
export function resolveIngestMode(env: Partial<NodeJS.ProcessEnv> = process.env): IngestMode {
  if (env.MINDER_INDEXER === "0") return "off";

  if (env.MINDER_INDEXER_WORKER === "1") return "worker";
  if (env.MINDER_PACKAGED === "1" && env.MINDER_INDEXER_WORKER !== "0") return "worker";

  return "in-process";
}
