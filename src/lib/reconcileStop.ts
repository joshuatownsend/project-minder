// Stop checks for a full reconcile pass (#677, #683). A dependency-free leaf, so the adapters'
// `discover()` and the ingest pipeline share one stop request without importing each other.

/** Once it returns true it must keep returning true: a pass re-asks only at its next checkpoint. */
export type ShouldStop = () => boolean;

/** A full pass that stopped because its caller is shutting down (#677). Not a failure. */
export class ReconcileStoppedError extends Error {
  constructor() {
    super("reconcile stopped: ingest is shutting down");
    this.name = "ReconcileStoppedError";
  }
}

export function throwIfStopped(shouldStop: ShouldStop | undefined): void {
  if (shouldStop?.()) throw new ReconcileStoppedError();
}

/** For a catch that otherwise tolerates a failure and carries on: a stop is not one of those. */
export function rethrowIfStopped(err: unknown): void {
  if (err instanceof ReconcileStoppedError) throw err;
}

/**
 * Yield to the event loop, then check. A stop request arrives as a worker message, and a
 * message is only handled while the loop is free, so a check at the end of a long synchronous
 * stretch would still read the old value. A no-op without a predicate, so callers that never
 * stop pay nothing.
 */
export async function yieldThenThrowIfStopped(shouldStop: ShouldStop | undefined): Promise<void> {
  if (!shouldStop) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfStopped(shouldStop);
}
