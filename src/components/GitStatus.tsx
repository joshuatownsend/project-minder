import { GitInfo } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import { GitBranch, Clock, AlertCircle } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * One source for the "not confirmed clean" caveat, used by both variants.
 *
 * #380's highest-stakes case: a failed `git status` renders where a dirty count
 * would be, so a reader who cannot reach the tooltip sees no uncommitted files
 * and concludes the repo is clean. The failure is indistinguishable from
 * success, which is why it must be readable without a mouse.
 */
const GIT_STATUS_UNKNOWN_EXPLANATION =
  "git status check failed (index.lock, timeout, or git missing) — this is not a confirmed-clean repo";

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
        {!git.isDirty && git.unknown && (
          // See GIT_STATUS_UNKNOWN_EXPLANATION above for why this one matters.
          //
          // Through `Tooltip` rather than `title` + `.sr-only` (#391): the
          // explanation is now ONE element, associated by `aria-describedby`,
          // reachable by hover, keyboard focus AND tap. The duplicated
          // `.sr-only` copy is gone with it — two copies of one sentence is a
          // drift waiting to happen.
          <Tooltip
            content={GIT_STATUS_UNKNOWN_EXPLANATION}
            className="flex items-center gap-1 text-[var(--muted-foreground)]"
          >
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            <span>status unavailable</span>
          </Tooltip>
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
      {!git.isDirty && git.unknown && (
        // THIS is the variant that ships. `ProjectCard` and `ProjectDetail`
        // both render `GitStatusCompact`; nothing in the app renders
        // `GitStatus`. The #380 fix went into the unrendered one, so for every
        // real flow a screen-reader user still got a bare "?" — the caveat was
        // repaired in a component no user reaches (Codex review, #390).
        //
        // And "?" is worse than "status unavailable": it carries no meaning at
        // all without the tooltip.
        <Tooltip content={GIT_STATUS_UNKNOWN_EXPLANATION}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              color: "var(--text-muted)",
              fontSize: "0.68rem",
              // Underlined, because a "?" that explains itself only on hover
              // gives a sighted keyboard or touch user no reason to think
              // there is anything to reach. The affordance has to be visible
              // for the tooltip to be discoverable (#391).
              textDecoration: "underline dotted",
              textUnderlineOffset: "2px",
              cursor: "help",
            }}
          >
            ?
          </span>
        </Tooltip>
      )}
      {git.lastCommitDate && (
        <span style={{ color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>
          {formatDistanceToNow(new Date(git.lastCommitDate), { addSuffix: true })}
        </span>
      )}
    </div>
  );
}
