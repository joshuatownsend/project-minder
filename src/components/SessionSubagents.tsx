import { SubagentInfo } from "@/lib/types";
import { Bot, Wrench } from "lucide-react";

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
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                #{String(i + 1).padStart(2, "0")}
              </span>
            </div>
            {agent.description && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {agent.description}
              </p>
            )}
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
