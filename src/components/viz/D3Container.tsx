"use client";

import { useRef, useEffect, useState, useCallback, ReactNode } from "react";
import { ChartTooltip } from "@/components/ui/ChartTooltip";

export interface D3RenderArgs {
  width: number;
  height: number;
  showTooltip: (x: number, y: number, content: string) => void;
  hideTooltip: () => void;
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DEFAULT_MARGIN: Margin = { top: 20, right: 16, bottom: 32, left: 48 };

interface D3ContainerProps {
  height?: number;
  margin?: Margin;
  children: (args: D3RenderArgs) => ReactNode;
  style?: React.CSSProperties;
}

interface TooltipState {
  x: number;
  y: number;
  content: string;
  visible: boolean;
}

/**
 * Shared chrome for D3 visualizations. Owns:
 * - A ResizeObserver that tracks container width
 * - The <svg> root
 * - A sibling <ChartTooltip> driven by showTooltip/hideTooltip callbacks
 *
 * Children receive width/height after margin subtraction, plus tooltip callbacks.
 * Lazy-loaded by each viz component (ssr:false).
 */
export function D3Container({
  height = 360,
  margin = DEFAULT_MARGIN,
  children,
  style,
}: D3ContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [tooltip, setTooltip] = useState<TooltipState>({
    x: 0, y: 0, content: "", visible: false,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const showTooltip = useCallback((x: number, y: number, content: string) => {
    setTooltip({ x, y, content, visible: true });
  }, []);

  const hideTooltip = useCallback(() => {
    setTooltip((t) => ({ ...t, visible: false }));
  }, []);

  const innerWidth = Math.max(0, containerWidth - margin.left - margin.right);
  const innerHeight = Math.max(0, height - margin.top - margin.bottom);

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative", ...style }}>
      {containerWidth > 0 && (
        <svg
          width={containerWidth}
          height={height}
          style={{ display: "block", overflow: "visible" }}
        >
          <g transform={`translate(${margin.left},${margin.top})`}>
            {children({ width: innerWidth, height: innerHeight, showTooltip, hideTooltip })}
          </g>
        </svg>
      )}
      {tooltip.visible && <ChartTooltip x={tooltip.x} y={tooltip.y} content={tooltip.content} />}
    </div>
  );
}

export interface AxisProps {
  xScale: d3ScaleAny;
  yScale: d3ScaleAny;
  width: number;
  height: number;
  xLabel?: string;
  yLabel?: string;
  tickCountX?: number;
  tickCountY?: number;
}

// Minimal type alias for d3 scales (avoids importing d3 in the framework file)
type d3ScaleAny = {
  ticks: (count?: number) => number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (value: any): number;
};

/**
 * Renders SVG axes + gridlines from caller-supplied d3 scale objects.
 * Mount inside the D3Container SVG <g> (already translated by margin).
 * Uses CSS custom properties for colors — see plan §2 for token list.
 */
export function Axes({
  xScale,
  yScale,
  width,
  height,
  xLabel,
  yLabel,
  tickCountX = 5,
  tickCountY = 5,
}: AxisProps) {
  const xTicks = xScale.ticks(tickCountX);
  const yTicks = yScale.ticks(tickCountY);

  const monoFont = "var(--font-mono)";
  const textMuted = "var(--text-muted)";
  const textSecondary = "var(--text-secondary)";
  const borderSubtle = "var(--border-subtle)";
  const borderDefault = "var(--border-default)";

  return (
    <g>
      {/* Horizontal gridlines */}
      {yTicks.map((t) => (
        <line
          key={t}
          x1={0}
          x2={width}
          y1={yScale(t)}
          y2={yScale(t)}
          stroke={borderSubtle}
          strokeWidth={1}
        />
      ))}

      {/* X axis */}
      <line x1={0} x2={width} y1={height} y2={height} stroke={borderDefault} strokeWidth={1} />
      {xTicks.map((t) => (
        <g key={t} transform={`translate(${xScale(t)},${height})`}>
          <text
            y={14}
            textAnchor="middle"
            fontSize="0.6rem"
            fill={textMuted}
            fontFamily={monoFont}
          >
            {t}
          </text>
        </g>
      ))}
      {xLabel && (
        <text
          x={width / 2}
          y={height + 28}
          textAnchor="middle"
          fontSize="0.65rem"
          fill={textSecondary}
        >
          {xLabel}
        </text>
      )}

      {/* Y axis */}
      <line x1={0} x2={0} y1={0} y2={height} stroke={borderDefault} strokeWidth={1} />
      {yTicks.map((t) => (
        <g key={t} transform={`translate(0,${yScale(t)})`}>
          <text
            x={-6}
            textAnchor="end"
            fontSize="0.6rem"
            fill={textMuted}
            fontFamily={monoFont}
            dominantBaseline="middle"
          >
            {t}
          </text>
        </g>
      ))}
      {yLabel && (
        <text
          transform={`translate(-36,${height / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize="0.65rem"
          fill={textSecondary}
        >
          {yLabel}
        </text>
      )}
    </g>
  );
}
