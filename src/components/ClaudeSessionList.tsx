import { ClaudeInfo } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare } from "lucide-react";

export function ClaudeSessionList({ claude }: { claude: ClaudeInfo }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Claude Sessions</h3>
        <span className="text-xs text-[var(--muted-foreground)]">
          {claude.sessionCount} total
        </span>
      </div>

      {claude.lastSessionDate && (
        <div className="rounded-md border p-3 space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4 text-[var(--muted-foreground)]" />
            <span className="text-[var(--muted-foreground)]">
              {formatDistanceToNow(new Date(claude.lastSessionDate), {
                addSuffix: true,
              })}
            </span>
          </div>
          {claude.lastPromptPreview && (
            <p className="text-sm text-[var(--muted-foreground)] pl-6 line-clamp-2">
              {claude.lastPromptPreview}
            </p>
          )}
        </div>
      )}

      {claude.sessionCount === 0 && (
        <p className="text-sm text-[var(--muted-foreground)]">No Claude sessions found.</p>
      )}
    </div>
  );
}

export function ClaudeSessionCompact({ claude }: { claude: ClaudeInfo }) {
  if (!claude.lastSessionDate) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "5px",
        fontSize: "0.7rem",
        color: "var(--text-muted)",
      }}
    >
      <MessageSquare style={{ width: "10px", height: "10px", flexShrink: 0 }} />
      <span style={{ flexShrink: 0 }}>
        {formatDistanceToNow(new Date(claude.lastSessionDate), { addSuffix: true })}
      </span>
      {claude.lastPromptPreview && (
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: "1 1 0",
            minWidth: 0,
          }}
        >
          · {claude.lastPromptPreview}
        </span>
      )}
    </div>
  );
}
