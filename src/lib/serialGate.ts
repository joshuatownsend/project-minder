/**
 * A minimal async serialization gate (#563).
 *
 * `run(fn)` chains calls so that each waits for the previous to settle before
 * starting — bounding concurrency to one. Introduced to serialize DB usage
 * report generation: once the aggregate queries yield between statements
 * (#559), overlapping `/api/usage` cache misses would otherwise each hold an
 * open snapshot connection and its accumulated arrays at once, multiplying
 * memory. The synchronous version serialized them; this restores that bound.
 *
 * A rejected `fn` must NOT wedge the queue: the chain advances on settle,
 * result or error alike, and `run` still rejects with that error to its own
 * caller.
 */
export interface SerialGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSerialGate(): SerialGate {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      // `.then(fn, fn)` starts fn whether the previous settled or threw.
      const result = tail.then(fn, fn);
      // The next caller waits for this one to settle; swallow so an error here
      // doesn't reject the shared tail (the error still reaches `result`).
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}
