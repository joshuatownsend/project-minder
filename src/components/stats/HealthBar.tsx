interface Segment {
  value: number;
  color: string; // CSS color value (e.g. "var(--accent)")
  label: string;
}

interface HealthBarProps {
  segments: Segment[];
}

export function HealthBar({ segments }: HealthBarProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) {
    return (
      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>No data</p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div
        style={{
          display: "flex",
          height: "6px",
          borderRadius: "3px",
          overflow: "hidden",
          background: "var(--bg-elevated)",
        }}
      >
        {segments.map(
          (seg) =>
            seg.value > 0 && (
              <div
                key={seg.label}
                style={{
                  width: "100%",
                  transform: `scaleX(${seg.value / total})`,
                  transformOrigin: "left",
                  background: seg.color,
                  transition: "transform 0.3s ease",
                }}
                title={`${seg.label}: ${seg.value}`}
              />
            )
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
        {segments.map((seg) => (
          <div key={seg.label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <div
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: seg.color,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{seg.label}</span>
            <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
              {seg.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
