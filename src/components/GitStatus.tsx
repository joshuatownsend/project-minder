import { GitInfo } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import { GitBranch, Clock, AlertCircle } from "lucide-react";

export function GitStatus({ git }: { git: GitInfo }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-[var(--muted-foreground)]" />
        <span className="font-mono">{git.branch}</span>
        {git.isDirty && (
          <span className="flex items-center gap-1" style={{ color: "var(--accent)" }}>
            <AlertCircle className="h-3 w-3" />
            {git.uncommittedCount} uncommitted
          </span>
        )}
      </div>
      {git.lastCommitDate && (
        <div className="flex items-center gap-2 text-[var(--muted-foreground)]">
          <Clock className="h-4 w-4" />
          <span>
            {formatDistanceToNow(new Date(git.lastCommitDate), { addSuffix: true })}
          </span>
        </div>
      )}
      {git.lastCommitMessage && (
        <p className="text-[var(--muted-foreground)] truncate pl-6">
          {git.lastCommitMessage}
        </p>
      )}
    </div>
  );
}

export function GitStatusCompact({ git }: { git: GitInfo }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "0.72rem",
        color: "var(--text-secondary)",
      }}
    >
      <GitBranch style={{ width: "11px", height: "11px", flexShrink: 0 }} />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: "1 1 0",
          minWidth: 0,
          color: git.isDirty ? "var(--accent)" : "var(--text-secondary)",
        }}
      >
        {git.branch}
      </span>
      {git.isDirty && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            color: "var(--accent)",
            fontSize: "0.68rem",
          }}
        >
          +{git.uncommittedCount}
        </span>
      )}
      {git.lastCommitDate && (
        <span style={{ color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>
          {formatDistanceToNow(new Date(git.lastCommitDate), { addSuffix: true })}
        </span>
      )}
    </div>
  );
}
