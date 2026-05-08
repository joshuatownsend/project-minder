export interface StripSegment {
  key: string;
  pct: number;
  color: string;
  label?: string;
}

interface StackedStripProps {
  segments: StripSegment[];
  height?: number;
  /** Total SVG width in px. Fills container when omitted (100%). */
  width?: number;
  title?: string;
}

/**
 * Horizontal stacked bar rendered as SVG. Each segment occupies `pct`% of the
 * total width. Rounding is applied so segment widths are integer px and the
 * total always fills the bar. A 0.5 px gap between segments provides visual
 * separation without affecting the reported percentages.
 */
export function StackedStrip({ segments, height = 6, width, title }: StackedStripProps) {
  const svgWidth = width ?? 80;
  const gap = 0.5;

  // Compute integer pixel widths that sum exactly to svgWidth.
  // Largest-remainder algorithm avoids drift without a reduce-then-clamp hack.
  const pctSum = segments.reduce((s, g) => s + g.pct, 0);
  if (pctSum === 0) return null;

  const exact = segments.map((g) => (g.pct / pctSum) * svgWidth);
  const floored = exact.map(Math.floor);
  const remainder = svgWidth - floored.reduce((s, w) => s + w, 0);
  const fracs = exact.map((v, i) => ({ i, frac: v - Math.floor(v) }));
  fracs.sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) floored[fracs[k].i]++;

  let x = 0;
  const rects: React.ReactNode[] = [];
  for (let i = 0; i < segments.length; i++) {
    const w = floored[i];
    if (w <= 0) { x += w; continue; }
    const g = i < segments.length - 1 ? gap : 0;
    rects.push(
      <rect
        key={segments[i].key}
        x={x}
        y={0}
        width={Math.max(0, w - g)}
        height={height}
        fill={segments[i].color}
        rx={1}
        ry={1}
      >
        {segments[i].label && <title>{segments[i].label}: {segments[i].pct.toFixed(0)}%</title>}
      </rect>
    );
    x += w;
  }

  const svgProps = width
    ? { width, height }
    : { width: "100%", height, viewBox: `0 0 80 ${height}`, preserveAspectRatio: "none" as const };

  return (
    <svg {...svgProps} aria-label={title} style={{ display: "block", flexShrink: 0, borderRadius: "1px" }}>
      {rects}
    </svg>
  );
}
