import { InsightsInfo } from "@/lib/types";
import { Lightbulb } from "lucide-react";

export function InsightsCompact({ insights }: { insights: InsightsInfo }) {
  if (insights.total === 0) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <Lightbulb style={{ width: "11px", height: "11px", color: "var(--text-muted)" }} />
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
        {insights.total} insight{insights.total !== 1 ? "s" : ""}
      </span>
    </div>
  );
}
