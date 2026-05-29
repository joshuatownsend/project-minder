// Defensive field coercers for parsing untrusted JSON records. Each returns
// `undefined` (never throws) on type mismatch, so a single bad field doesn't
// poison the whole parse — the caller drops the field but keeps the rest.
//
// Shared by the on-disk JSON readers under src/lib (Claude Code hook payloads,
// the stats-cache / session-meta files, …). Keep these leaf helpers here so
// new readers reuse them instead of re-declaring the same primitives.

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
