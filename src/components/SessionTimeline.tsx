"use client";

import { useState } from "react";
import { TimelineEvent } from "@/lib/types";
import {
  User,
  Bot,
  Wrench,
  Brain,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

const EVENT_STYLES: Record<
  TimelineEvent["type"],
  { icon: typeof User; colorClass: string; bgClass: string }
> = {
  user: { icon: User, colorClass: "text-blue-400", bgClass: "bg-blue-500/10" },
  assistant: { icon: Bot, colorClass: "text-emerald-400", bgClass: "bg-emerald-500/10" },
  tool_use: { icon: Wrench, colorClass: "text-violet-400", bgClass: "bg-violet-500/10" },
  thinking: { icon: Brain, colorClass: "text-gray-400", bgClass: "bg-gray-500/10" },
  error: { icon: AlertCircle, colorClass: "text-red-400", bgClass: "bg-red-500/10" },
};

function formatOffset(timestamp: string | undefined, sessionStart: string | undefined): string {
  if (!timestamp || !sessionStart) return "";
  const offset = new Date(timestamp).getTime() - new Date(sessionStart).getTime();
  if (offset < 0) return "";
  const seconds = Math.floor(offset / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `+${seconds}s`;
  return `+${minutes}m${seconds % 60}s`;
}

function TimelineItem({
  event,
  sessionStart,
}: {
  event: TimelineEvent;
  sessionStart?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const style = EVENT_STYLES[event.type];
  const Icon = style.icon;
  const isLong = event.content.length > 150;
  const displayText = isLong && !expanded ? event.content.slice(0, 150) + "..." : event.content;

  return (
    <div className={`flex gap-3 p-2 rounded ${style.bgClass}`}>
      <div className={`mt-0.5 shrink-0 ${style.colorClass}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${style.colorClass}`}>
            {event.type === "tool_use" ? event.toolName || "Tool" : event.type}
          </span>
          <span className="text-[10px] text-[var(--muted-foreground)] font-mono">
            {formatOffset(event.timestamp, sessionStart)}
          </span>
          {event.tokenCount && (
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {event.tokenCount} tokens
            </span>
          )}
        </div>
        <p className="text-sm whitespace-pre-wrap break-words">{displayText}</p>
        {isLong && (
          <button
            className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] flex items-center gap-0.5"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <><ChevronDown className="h-3 w-3" /> Show less</>
            ) : (
              <><ChevronRight className="h-3 w-3" /> Show more</>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export function SessionTimeline({
  timeline,
  sessionStart,
}: {
  timeline: TimelineEvent[];
  sessionStart?: string;
}) {
  if (timeline.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">
        No timeline events.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {timeline.map((event, i) => (
        <TimelineItem key={i} event={event} sessionStart={sessionStart} />
      ))}
    </div>
  );
}
