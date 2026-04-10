import { InsightsInfo } from "@/lib/types";
import { Lightbulb } from "lucide-react";

export function InsightsCompact({ insights }: { insights: InsightsInfo }) {
  if (insights.total === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-violet-400">
      <Lightbulb className="h-3 w-3" />
      <span>
        {insights.total} insight{insights.total !== 1 ? "s" : ""}
      </span>
    </div>
  );
}
