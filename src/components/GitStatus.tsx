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
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
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
    <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
      <GitBranch className="h-3 w-3" />
      <span className="font-mono">{git.branch}</span>
      {git.isDirty && (
        <span className="text-amber-600 dark:text-amber-400">
          +{git.uncommittedCount}
        </span>
      )}
      {git.lastCommitDate && (
        <span>
          {formatDistanceToNow(new Date(git.lastCommitDate), { addSuffix: true })}
        </span>
      )}
    </div>
  );
}
