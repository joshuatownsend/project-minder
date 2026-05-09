"use client";

const SOURCE_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function SourceBadge({ source }: { source?: string }) {
  const src = source ?? "claude";
  const label = formatSourceLabel(src);
  return (
    <span
      title={`Session source: ${label}`}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.65rem",
        color: "var(--text-secondary)",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}
