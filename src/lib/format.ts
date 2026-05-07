export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function msLabel(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// Returns an ISO-8601 string for N days ago (default 7).
export function defaultSince(days = 7): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
