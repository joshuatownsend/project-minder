/**
 * Deterministic per-project color, used by ProjectGlyph and any other
 * place that needs a stable visual identity for a project (Home recent
 * tiles, ProjectScopeMenu modal entries, cost-by-project bars).
 *
 * The palette mirrors the dataviz tokens defined in globals.css. The
 * mapping is hash-based on slug (with optional index salt) so the same
 * project keeps the same color across pages and re-renders, but two
 * projects with the same first letter — e.g. `project-minder`,
 * `patchmaven`, `perfect-palette-monorepo` — get distinguishable hues
 * (was MEDIUM-8 in the 2026-05-10 review).
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

export function projectColor(slug: string, idx = 0): string {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h + idx) % PALETTE.length];
}
