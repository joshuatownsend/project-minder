/**
 * Claudoscope design primitives — small, framework-agnostic React building
 * blocks that mirror the visual language defined in globals.css. Each
 * component intentionally maps to a CSS class so styling lives in one place
 * and components stay layout-only.
 *
 * These are presentational and stateless — no "use client" pragma so they
 * can be imported by either server or client parents without forcing client
 * boundary semantics on themselves.
 */

import type { ReactNode, CSSProperties } from "react";

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
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--bg-elev-2)" strokeWidth={thick} fill="none" />
      {slices.map((s, i) => {
        const length = (s.value / total) * circumference;
        const dasharray = `${length} ${circumference - length}`;
        const dashoffset = -offset;
        offset += length;
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

export function StackedBars({
  data,
  height = 200,
  colors = ["var(--info)", "var(--good)"],
}: {
  data: { label: string; values: number[] }[];
  height?: number;
  colors?: string[];
}) {
  const padding = { top: 16, bottom: 24, left: 32, right: 8 };
  const max = Math.max(1, ...data.map((d) => d.values.reduce((s, v) => s + v, 0)));
  const innerH = height - padding.top - padding.bottom;
  return (
    <svg viewBox={`0 0 ${data.length * 60 + padding.left + padding.right} ${height}`} preserveAspectRatio="none" width="100%" height={height}>
      {/* Y-axis baseline */}
      <line
        x1={padding.left}
        x2={data.length * 60 + padding.left}
        y1={padding.top + innerH}
        y2={padding.top + innerH}
        stroke="var(--line-soft)"
        strokeWidth={1}
      />
      {data.map((d, i) => {
        const total = d.values.reduce((s, v) => s + v, 0);
        const totalH = (total / max) * innerH;
        const x = padding.left + i * 60 + 12;
        let stackY = padding.top + innerH;
        return (
          <g key={d.label}>
            {d.values.map((v, j) => {
              const h = (v / max) * innerH;
              stackY -= h;
              return (
                <rect
                  key={j}
                  x={x}
                  y={stackY}
                  width={36}
                  height={Math.max(1, h)}
                  fill={colors[j % colors.length]}
                  rx={2}
                />
              );
            })}
            <text
              x={x + 18}
              y={padding.top + innerH + 14}
              textAnchor="middle"
              fontSize={10}
              fill="var(--text-3)"
              fontFamily="var(--font-mono)"
            >
              {d.label}
            </text>
            <title>{`${d.label}: ${total}`}</title>
            {/* Suppress unused var warning */}
            <desc>{totalH}</desc>
          </g>
        );
      })}
    </svg>
  );
}
