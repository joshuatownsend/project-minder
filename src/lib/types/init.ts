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
