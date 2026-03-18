interface Segment {
  value: number;
  colorClass: string;
  label: string;
}

interface HealthBarProps {
  segments: Segment[];
}

export function HealthBar({ segments }: HealthBarProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)]">No data</p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex h-4 rounded-full overflow-hidden bg-[var(--muted)]">
        {segments.map(
          (seg) =>
            seg.value > 0 && (
              <div
                key={seg.label}
                className={`${seg.colorClass} transition-all`}
                style={{ width: `${(seg.value / total) * 100}%` }}
                title={`${seg.label}: ${seg.value}`}
              />
            )
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5 text-xs">
            <div className={`w-2.5 h-2.5 rounded-full ${seg.colorClass}`} />
            <span className="text-[var(--muted-foreground)]">{seg.label}</span>
            <span className="font-mono">{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
