/**
 * Deterministic per-project color, used by ProjectGlyph and any other
 * place that needs a stable visual identity for a project (Home recent
 * tiles, ProjectScopeMenu modal entries, cost-by-project bars).
 *
 * The palette mirrors the dataviz tokens defined in globals.css. The
 * mapping is hash-based on slug ONLY — no list-index salt — so the same
 * slug always maps to the same palette entry across pages, sorts, and
 * filters. Earlier versions accepted an `idx` salt that callers passed
 * the array index from a .map(), which made colors flicker as ordering
 * changed (PR #102 review: copilot called this out across 6 sites).
 */

const PALETTE = [
  "var(--info)",
  "var(--good)",
  "var(--accent)",
  "var(--purple)",
  "oklch(0.66 0.14 320)",
  "oklch(0.62 0.10 175)",
  "oklch(0.68 0.14 50)",
  "var(--danger)",
];

export function projectColor(slug: string): string {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
