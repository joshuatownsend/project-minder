/**
 * Snapshot of the SQLite-index schema-readiness state machine in
 * `src/lib/data/index.ts`. Lives here (not next to the state machine)
 * because `data/index.ts` is `server-only` and `SettingsPage` needs the
 * type for the DB-status footer that polls `/api/health`.
 */
export type InitStateKind =
  | "idle"
  | "in-flight"
  | "success"
  | "transient-failed"
  | "permanent-failed";

export interface InitStatus {
  state: InitStateKind;
  attempts: number;
  quarantineRuns: number;
  /** Wall-clock ms when the last failure was committed; null otherwise. */
  failedAt: number | null;
  lastError: { message: string; code?: string } | null;
}

/**
 * The `/api/health` response body — the stable contract the tray app polls and
 * the Home banner + Settings page read.
 *
 * Declared here, beside `InitStatus` and for the same reason: the route is
 * server-only, and browser callers need the shape. Both sides import this —
 * the route annotates its body with it, so dropping or renaming a field is a
 * type error at the producer rather than a field that silently arrives
 * `undefined` at every consumer. A client-side interface alone could not do
 * that: `res.json()` is `any`, so a hand-written response type asserts the
 * shape rather than verifying it.
 *
 * Note the body is returned with HTTP 503 for every `db.state` other than
 * `success`, and is fully populated either way — consumers must read the body
 * regardless of status code.
 */
export interface HealthResponse {
  /** Legacy field: true ONLY when `db.state === "success"`. */
  ok: boolean;
  status: "ok" | "degraded";
  /** `package.json` version, or the literal `"unknown"` if it can't be read. */
  version: string;
  uptimeSec: number;
  demoMode: boolean;
  db: InitStatus;
  /**
   * Bootstrap + watcher diagnostics. Deliberately loose: no browser consumer
   * reads them, and typing them precisely would couple this browser-safe file
   * to server-only modules — the exact dependency it exists to avoid.
   */
  bootstrap: unknown;
  watchers: Record<string, number | boolean>;
}
