"use client";

/**
 * Claudoscope design primitives — small React building blocks that mirror
 * the visual language defined in globals.css. Each component intentionally
 * maps to a CSS class so styling lives in one place and components stay
 * layout-only.
 *
 * Marked "use client" because StackedBars uses ResizeObserver to make the
 * chart width-responsive. The other primitives are presentational but they
 * already only render under client parents (every page in src/app uses
 * client components).
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode, CSSProperties } from "react";
import { AlertCircle, AlertOctagon, AlertTriangle, Info } from "lucide-react";

/* ---------- Page header ---------- */

export function PageHeader({
  title,
  sub,
  right,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="left">
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {right && <div>{right}</div>}
    </header>
  );
}

/* ---------- Card ---------- */

export function Card({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={"ds-card" + (className ? " " + className : "")} style={style}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  sub,
  right,
  icon,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="ds-card-h">
      {icon}
      <h3>{title}</h3>
      {sub && <span className="sub">{sub}</span>}
      {right && <div className="right">{right}</div>}
    </div>
  );
}

/* ---------- Stat card ---------- */

export function Stat({
  label,
  value,
  sub,
  accent,
  spark,
  sparkColor,
  cost,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
  spark?: number[];
  sparkColor?: string;
  /** When true, applies the warning color to the value (used for spend/cost). */
  cost?: boolean;
}) {
  return (
    <div className={"stat-card" + (cost ? " cost" : "")}>
      <div className="label">
        {accent && <span className="accent-dot" style={{ background: accent }} />}
        {label}
      </div>
      <div className="value">{value}</div>
      {sub && <div className="delta">{sub}</div>}
      {spark && spark.length > 0 && (
        <div className="spark">
          <Sparkline values={spark} color={sparkColor || "var(--info)"} height={28} />
        </div>
      )}
    </div>
  );
}

/* ---------- Pill / Tag / Seg ---------- */

export function Pill({
  children,
  onClick,
  style,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={"pill" + (className ? " " + className : "")}
      style={style}
    >
      {children}
    </button>
  );
}

export type TagVariant = "default" | "danger" | "warn" | "good" | "info" | "purple";
export function Tag({
  children,
  variant = "default",
  className,
  style,
}: {
  children: ReactNode;
  variant?: TagVariant;
  className?: string;
  style?: CSSProperties;
}) {
  const variantClass = variant === "default" ? "" : ` ${variant}`;
  return (
    <span className={"tag" + variantClass + (className ? " " + className : "")} style={style}>
      {children}
    </span>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className={opt.value === value ? "active" : undefined}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Severity tokens (shared by FindingCard + group headers) ---------- */

/** Canonical severity tone, shared across panels that surface findings.
 *
 *  Three tones are sufficient for every consumer today:
 *   - `crit`   — highest urgency (red).      Maps from DiagnosisPanel `P0`, EfficiencyTab `high`,    ClaudeMdAudit `P0`.
 *   - `high`   — second tier (amber/accent). Maps from DiagnosisPanel `P1`, EfficiencyTab `medium`,  ClaudeMdAudit `P1`.
 *   - `med`    — informational (muted).      Maps from DiagnosisPanel `P2`, EfficiencyTab `low`,     ClaudeMdAudit `P2`.
 *
 *  Add new tones only when a fourth class actually shows up — keeping the
 *  set small means we never have to invent a fifth-rank visual treatment
 *  that no consumer needs. */
export type SeverityTone = "crit" | "high" | "med";

export const severityTokens: Record<
  SeverityTone,
  { bg: string; border: string; text: string; icon: ReactNode }
> = {
  crit: {
    bg: "var(--status-error-bg)",
    border: "var(--status-error-border)",
    text: "var(--status-error-text)",
    icon: <AlertOctagon style={{ width: "12px", height: "12px" }} />,
  },
  high: {
    bg: "var(--accent-bg)",
    border: "var(--accent-border)",
    text: "var(--accent)",
    icon: <AlertTriangle style={{ width: "12px", height: "12px" }} />,
  },
  med: {
    bg: "var(--bg-elevated)",
    border: "var(--border-subtle)",
    text: "var(--text-secondary)",
    icon: <Info style={{ width: "12px", height: "12px" }} />,
  },
};

/* ---------- ErrorBanner (red alert row with optional label) ---------- */

/** Inline error banner. Used in places where a panel-local error needs to
 *  surface without disrupting the page layout (e.g. the screenshot
 *  playground's convert API errors and the preview iframe's compile/runtime
 *  errors).
 *
 *  `label` renders as a small monospace header above the message —
 *  callers pass it pre-cased (the component does NOT force uppercase) so
 *  the label can be used for any short disambiguator, e.g. "PREVIEW
 *  ERROR" vs a bare network error label. */
export function ErrorBanner({
  message,
  label,
}: {
  message: string;
  label?: string;
}) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        gap: "8px",
        alignItems: "flex-start",
        padding: "8px 12px",
        background: "var(--error-bg, #2a0000)",
        borderRadius: "var(--radius)",
        fontSize: "0.78rem",
        color: "var(--error, #f87171)",
      }}
    >
      <AlertCircle style={{ width: "14px", height: "14px", flex: "0 0 14px", marginTop: "2px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
        {label && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.04em" }}>
            {label}
          </span>
        )}
        <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>{message}</span>
      </div>
    </div>
  );
}

/* ---------- ProjectGlyph (gradient initial) ---------- */

export function ProjectGlyph({
  name,
  color,
  size = 24,
}: {
  name: string;
  /** Any valid CSS color (oklch / hex / token reference). Defaults to --info. */
  color?: string;
  size?: number;
}) {
  const ch = (name || "?").replace(/^\W+/, "")[0]?.toUpperCase() || "?";
  const c = color || "var(--info)";
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: `linear-gradient(135deg, ${c} 0%, color-mix(in oklch, ${c} 65%, transparent) 100%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: size * 0.46,
        color: "var(--bg)",
        flexShrink: 0,
        letterSpacing: "-0.02em",
      }}
    >
      {ch}
    </div>
  );
}

/* ---------- Sparkline ---------- */

export function Sparkline({
  values,
  color = "var(--info)",
  width = 80,
  height = 24,
  strokeWidth = 1.5,
  fill = true,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  fill?: boolean;
}) {
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = "M" + points.join(" L");
  const areaPath = path + ` L${width.toFixed(1)},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      {fill && (
        <path
          d={areaPath}
          fill={color}
          opacity={0.12}
        />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- Donut ---------- */

export function Donut({
  slices,
  size = 120,
  thick = 14,
}: {
  slices: { value: number; color: string }[];
  size?: number;
  thick?: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - thick / 2;
  const circumference = 2 * Math.PI * r;
  // Precompute cumulative offsets so we don't mutate a `let` accumulator
  // inside the slice map — the React Compiler purity rule treats post-render
  // reassignment as a violation. Same math, just done declaratively.
  const sliceLengths = slices.map((s) => (s.value / total) * circumference);
  const sliceOffsets = sliceLengths.reduce<number[]>(
    (acc, _length, idx) => [...acc, idx === 0 ? 0 : acc[idx - 1] + sliceLengths[idx - 1]],
    [],
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--bg-elev-2)" strokeWidth={thick} fill="none" />
      {slices.map((s, i) => {
        const length = sliceLengths[i];
        const dasharray = `${length} ${circumference - length}`;
        const dashoffset = -sliceOffsets[i];
        return (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={s.color}
            strokeWidth={thick}
            fill="none"
            strokeDasharray={dasharray}
            strokeDashoffset={dashoffset}
            strokeLinecap="butt"
          />
        );
      })}
    </svg>
  );
}

/* ---------- GaugeRing (semi/full radial gauge) ---------- */

export function GaugeRing({
  pct,
  size = 110,
  thick = 8,
  color = "var(--accent)",
  trackColor = "var(--bg-elev-2)",
}: {
  pct: number;
  size?: number;
  thick?: number;
  color?: string;
  trackColor?: string;
}) {
  const safe = Math.max(0, Math.min(100, pct));
  const r = size / 2 - thick / 2;
  const c = 2 * Math.PI * r;
  const dash = (safe / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke={trackColor} strokeWidth={thick} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={thick}
        fill="none"
        strokeDasharray={`${dash} ${c - dash}`}
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ---------- StackedBars ---------- */

/**
 * Width-responsive stacked bar chart.
 *
 * Implementation note: an earlier version used `preserveAspectRatio="none"`
 * with a fixed-pixel viewBox, which made the SVG scale uniformly to fill
 * the parent — including the x-axis date text, which ended up horizontally
 * stretched. We now measure the parent's width via ResizeObserver and
 * size the SVG in pixel-space, so bars stay at a fixed 36px and text
 * stays crisp at 1:1.
 */
export function StackedBars({
  data,
  height = 200,
  colors = ["var(--info)", "var(--good)"],
}: {
  data: { label: string; values: number[] }[];
  height?: number;
  colors?: string[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padding = { top: 16, bottom: 24, left: 32, right: 8 };
  const max = Math.max(1, ...data.map((d) => d.values.reduce((s, v) => s + v, 0)));
  const innerH = height - padding.top - padding.bottom;
  const innerW = Math.max(60, width - padding.left - padding.right);
  // Distribute columns evenly. Bar width = column width minus a small gap,
  // capped at 36px so wide containers keep clean rectangles instead of slabs.
  const columnW = data.length > 0 ? innerW / data.length : innerW;
  const barW = Math.max(4, Math.min(36, columnW - 8));

  return (
    <div ref={containerRef} style={{ width: "100%", height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
        {/* Y-axis baseline */}
        <line
          x1={padding.left}
          x2={padding.left + innerW}
          y1={padding.top + innerH}
          y2={padding.top + innerH}
          stroke="var(--line-soft)"
          strokeWidth={1}
        />
        {data.map((d, i) => {
          const total = d.values.reduce((s, v) => s + v, 0);
          const cx = padding.left + i * columnW + columnW / 2;
          // Allocate the total bar height first, then distribute across the
          // non-zero series. Token-usage stacks frequently have 1:500+
          // input:output ratios, which would render the input segment at
          // sub-pixel height and disappear visually. We clamp non-zero
          // series to MIN_VISIBLE_PX, then steal the deficit back from the
          // larger series proportional to their overage above MIN_VISIBLE_PX,
          // so the stack height STILL sums to the allocated total instead
          // of overshooting and clipping above padding.top (PR #102).
          const MIN_VISIBLE_PX = 2;
          const totalH = total > 0 ? (total / max) * innerH : 0;
          const proportional = d.values.map((v) =>
            total > 0 && v > 0 ? (v / total) * totalH : 0,
          );
          // First pass: clamp positive segments below MIN_VISIBLE up.
          const clamped = proportional.map((h) =>
            h > 0 && h < MIN_VISIBLE_PX ? MIN_VISIBLE_PX : h,
          );
          // Second pass: redistribute any overshoot back from segments that
          // have headroom above MIN_VISIBLE_PX, weighted by their excess.
          const overshoot = clamped.reduce((s, h) => s + h, 0) - totalH;
          let heights = clamped;
          if (overshoot > 0) {
            const headroomTotal = clamped.reduce(
              (s, h) => s + Math.max(0, h - MIN_VISIBLE_PX),
              0,
            );
            if (headroomTotal > 0) {
              heights = clamped.map((h) => {
                const headroom = Math.max(0, h - MIN_VISIBLE_PX);
                const give = (headroom / headroomTotal) * overshoot;
                return Math.max(MIN_VISIBLE_PX, h - give);
              });
            }
          }
          // Cumulative ys from bottom up — declarative so we don't mutate
          // a `let` accumulator inside the segment map.
          const segmentYs = heights.reduce<number[]>((acc, h, idx) => {
            const prevY = idx === 0 ? padding.top + innerH : acc[idx - 1];
            return [...acc, prevY - h];
          }, []);
          return (
            <g key={d.label}>
              {d.values.map((v, j) => {
                if (v <= 0) return null;
                return (
                  <rect
                    key={j}
                    x={cx - barW / 2}
                    y={segmentYs[j]}
                    width={barW}
                    height={heights[j]}
                    fill={colors[j % colors.length]}
                    rx={2}
                  />
                );
              })}
              <text
                x={cx}
                y={padding.top + innerH + 14}
                textAnchor="middle"
                fontSize={10}
                fill="var(--text-3)"
                fontFamily="var(--font-mono)"
              >
                {d.label}
              </text>
              <title>{`${d.label}: ${total}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
