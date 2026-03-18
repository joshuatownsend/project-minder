import { SubagentInfo } from "@/lib/types";
import { Bot, Wrench } from "lucide-react";
import { Badge } from "./ui/badge";

export function SessionSubagents({ subagents }: { subagents: SubagentInfo[] }) {
  if (subagents.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">
        No subagents spawned in this session.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {subagents.map((agent) => {
        const topTools = Object.entries(agent.toolUsage)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

        return (
          <div key={agent.agentId} className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-violet-400" />
              <span className="text-sm font-medium">{agent.type}</span>
            </div>
            <p className="text-xs text-[var(--muted-foreground)] line-clamp-2">
              {agent.description}
            </p>
            {topTools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {topTools.map(([tool, count]) => (
                  <Badge key={tool} variant="outline" className="text-[10px] px-1.5 py-0">
                    <Wrench className="h-2.5 w-2.5 mr-0.5" />
                    {tool} ({count})
                  </Badge>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
