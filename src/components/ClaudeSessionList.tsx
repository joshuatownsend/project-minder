import { ClaudeInfo } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare } from "lucide-react";

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
