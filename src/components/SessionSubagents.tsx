import { SubagentInfo } from "@/lib/types";
import type { SubagentCategory } from "@/lib/types";
import { Bot, Wrench, DollarSign, Clock, Cpu } from "lucide-react";
import { formatCostCompact } from "@/lib/format";

const CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "3px",
  fontFamily: "var(--font-mono)", fontSize: "0.62rem",
  color: "var(--text-muted)", background: "var(--bg-elevated)",
  border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "1px 5px",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs > 0 ? `${m}m${rs}s` : `${m}m`;
}

// Strip the long Anthropic prefix so model labels fit in the chip row.
// `claude-sonnet-4-6` is more useful than the full vendor-prefixed string.
function shortenModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-2025\d{4}.*$/, "");
}

const BLUE_BG   = "oklch(0.15 0.04 250)";
const BLUE_TEXT  = "oklch(0.62 0.12 250)";

const CATEGORY_COLORS: Record<SubagentCategory, { bg: string; text: string }> = {
  fix:      { bg: "var(--status-error-bg)",   text: "var(--status-error-text)"  },
  find:     { bg: BLUE_BG,                    text: BLUE_TEXT                   },
  query:    { bg: BLUE_BG,                    text: BLUE_TEXT                   },
  research: { bg: BLUE_BG,                    text: BLUE_TEXT                   },
  check:    { bg: "var(--accent-bg)",         text: "var(--accent)"             },
  create:   { bg: "var(--status-active-bg)",  text: "var(--status-active-text)" },
  other:    { bg: "var(--bg-elevated)",       text: "var(--text-muted)"         },
};

export function SessionSubagents({ subagents }: { subagents: SubagentInfo[] }) {
  if (subagents.length === 0) {
    return <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>No subagents spawned in this session.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {subagents.map((agent, i) => {
        const topTools = Object.entries(agent.toolUsage).sort((a, b) => b[1] - a[1]).slice(0, 5);
        return (
          <div
            key={agent.agentId}
            style={{ padding: "12px 0", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: "6px" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Bot style={{ width: "12px", height: "12px", color: "var(--text-muted)", flexShrink: 0 }} />
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-body)" }}>
                {agent.type}
              </span>
              {agent.category && (() => {
                const colors = CATEGORY_COLORS[agent.category];
                return (
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 6px",
                      borderRadius: "3px",
                      fontSize: "0.62rem",
                      fontFamily: "var(--font-mono)",
                      background: colors.bg,
                      color: colors.text,
                    }}
                  >
                    {agent.category}
                  </span>
                );
              })()}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                #{String(i + 1).padStart(2, "0")}
              </span>
            </div>
            {agent.description && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {agent.description}
              </p>
            )}
            {(agent.costUsd !== undefined || agent.model || agent.durationMs !== undefined || agent.totalTokens !== undefined) && (() => {
              // Prefer the precise (input + output) sum from api_request rollup;
              // fall back to `totalTokens` (input+output combined) from the
              // subagent_completed rollup when api_request data is missing.
              const tokenChip = agent.inputTokens !== undefined
                ? agent.inputTokens + (agent.outputTokens ?? 0)
                : agent.totalTokens;
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                  {agent.costUsd !== undefined && agent.costUsd > 0 && (
                    <span style={CHIP_STYLE} title={`Input: ${agent.inputTokens ?? 0} · Output: ${agent.outputTokens ?? 0} · Cache read: ${agent.cacheReadTokens ?? 0} · Cache write: ${agent.cacheCreateTokens ?? 0}`}>
                      <DollarSign style={{ width: "9px", height: "9px" }} />
                      {formatCostCompact(agent.costUsd)}
                    </span>
                  )}
                  {tokenChip !== undefined && tokenChip > 0 && (
                    <span style={CHIP_STYLE} title={agent.inputTokens !== undefined ? "Input + output tokens (excludes cache hits)" : "Total tokens (input + output, no split available)"}>
                      {formatTokens(tokenChip)} tok
                    </span>
                  )}
                  {agent.model && (
                    <span style={CHIP_STYLE} title={`Model: ${agent.model}`}>
                      <Cpu style={{ width: "9px", height: "9px" }} />
                      {shortenModel(agent.model)}
                    </span>
                  )}
                  {agent.durationMs !== undefined && agent.durationMs > 0 && (
                    <span style={CHIP_STYLE} title={`Duration of subagent invocation (${formatDuration(agent.durationMs)})`}>
                      <Clock style={{ width: "9px", height: "9px" }} />
                      {formatDuration(agent.durationMs)}
                    </span>
                  )}
                </div>
              );
            })()}
            {topTools.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {topTools.map(([tool, count]) => (
                  <span
                    key={tool}
                    style={{ display: "inline-flex", alignItems: "center", gap: "3px", fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)", background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "1px 5px" }}
                  >
                    <Wrench style={{ width: "9px", height: "9px" }} />
                    {tool} ({count})
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
