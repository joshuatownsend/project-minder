interface BarChartProps {
  data: Record<string, number>;
  maxItems?: number;
  colorClass?: string;
  color?: string; // CSS color value, overrides colorClass
}

export function BarChart({
  data,
  maxItems = 10,
  colorClass = "bg-blue-500",
  color,
}: BarChartProps) {
  const sorted = Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems);

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)]">No data</p>
    );
  }

  const max = sorted[0][1];

  return (
    <div className="space-y-1.5">
      {sorted.map(([label, count]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted-foreground)] w-28 truncate text-right shrink-0">
            {label}
          </span>
          <div className="flex-1 bg-[var(--muted)] rounded-full h-4 overflow-hidden">
            <div
              className={color ? undefined : `${colorClass} h-4 rounded-full transition-all`}
              style={{
                width: `${max > 0 ? (count / max) * 100 : 0}%`,
                ...(color ? { height: "100%", background: color, borderRadius: "9999px", transition: "width 0.3s" } : {}),
              }}
            />
          </div>
          <span className="text-xs font-mono w-8 text-right shrink-0">{count}</span>
        </div>
      ))}
    </div>
  );
}
