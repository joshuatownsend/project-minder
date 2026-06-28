"use client";

import { useState } from "react";
import Link from "next/link";
import { GitPullRequest, Clock, CircleDot, ChevronDown, ChevronRight } from "lucide-react";
import type { GithubActivity, GithubCiStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";

// CI dot color by status. `unknown` renders nothing.
const CI_COLOR: Record<Exclude<GithubCiStatus, "unknown">, string> = {
  passing: "var(--status-active-text)",
  failing: "var(--status-error-text)",
  pending: "var(--accent)",
};

const CI_LABEL: Record<GithubCiStatus, string> = {
  passing: "CI passing",
  failing: "CI failing",
  pending: "CI running",
  unknown: "CI unknown",
};

function CiDot({ status }: { status: GithubCiStatus }) {
  if (status === "unknown") return null;
  return (
    <span
      style={{
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: CI_COLOR[status],
        flexShrink: 0,
        animation: status === "pending" ? "pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

/** Opens an external URL without triggering the enclosing card <Link>. Used in
 *  compact (card) mode where nesting an <a> inside the card's <a> is invalid. */
function openExternal(e: React.MouseEvent, url?: string) {
  e.preventDefault();
  e.stopPropagation();
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

interface GithubActivityStripProps {
  activity?: GithubActivity;
  /** Card density: a single muted chip row with no enclosed anchors. */
  compact?: boolean;
  /** Full-mode only: `${repo}#${number}` → sessionId, for the PR↔session join. */
  prSessionLinks?: Record<string, string>;
}

export function GithubActivityStrip({
  activity,
  compact = false,
  prSessionLinks,
}: GithubActivityStripProps) {
  const [expanded, setExpanded] = useState(false);

  // Quiet by design: an absent or unavailable result renders nothing.
  if (!activity || !activity.available) return null;

  const repo = activity.repo;
  const openPrCount = activity.openPrCount ?? 0;
  const ci = activity.ci;
  const pushedRel = activity.lastPushAt ? formatRelativeTime(activity.lastPushAt) : null;
  const pullsUrl = repo ? `https://github.com/${repo}/pulls` : undefined;

  // Nothing worth showing.
  const showPrs = openPrCount > 0;
  const showCi = !!ci && ci.status !== "unknown";
  const showPushed = !!pushedRel;
  if (!showPrs && !showCi && !showPushed) return null;

  // ── Compact (card) — span-based chips, no nested anchors ──────────────────
  if (compact) {
    return (
      <div
        style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}
        onClick={(e) => e.preventDefault()}
      >
        {showPrs && (
          <span
            role="link"
            tabIndex={0}
            title={`${openPrCount} open pull request${openPrCount !== 1 ? "s" : ""} — open on GitHub`}
            onClick={(e) => openExternal(e, pullsUrl)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") openExternal(e as unknown as React.MouseEvent, pullsUrl);
            }}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              fontSize: "0.72rem", fontWeight: 500, fontFamily: "var(--font-mono)",
              color: "var(--accent)", cursor: "pointer",
            }}
          >
            <GitPullRequest style={{ width: "11px", height: "11px" }} />
            {openPrCount} PR{openPrCount !== 1 ? "s" : ""}
          </span>
        )}
        {showCi && ci && (
          <span
            role={ci.url ? "link" : undefined}
            tabIndex={ci.url ? 0 : undefined}
            title={`${CI_LABEL[ci.status]}${ci.workflowName ? ` · ${ci.workflowName}` : ""}${ci.url ? " — open run" : ""}`}
            onClick={ci.url ? (e) => openExternal(e, ci.url) : undefined}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)",
              cursor: ci.url ? "pointer" : "default",
            }}
          >
            <CiDot status={ci.status} />
            CI
          </span>
        )}
        {showPushed && (
          <span
            title={`Last push ${pushedRel}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)",
            }}
          >
            <Clock style={{ width: "10px", height: "10px" }} />
            {pushedRel}
          </span>
        )}
      </div>
    );
  }

  // ── Full (detail) — real anchors + expandable PR list ─────────────────────
  const prs = activity.prs ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
        {showPrs ? (
          <a
            href={pullsUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setExpanded((v) => !v)}
            style={{
              display: "inline-flex", alignItems: "center", gap: "5px",
              fontSize: "0.78rem", fontWeight: 600, fontFamily: "var(--font-mono)",
              color: "var(--accent)", textDecoration: "none",
            }}
          >
            <GitPullRequest style={{ width: "13px", height: "13px" }} />
            {openPrCount} open PR{openPrCount !== 1 ? "s" : ""}
          </a>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "0.78rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <GitPullRequest style={{ width: "13px", height: "13px" }} />
            No open PRs
          </span>
        )}

        {showCi && ci && (
          ci.url ? (
            <a
              href={ci.url}
              target="_blank"
              rel="noopener noreferrer"
              title={CI_LABEL[ci.status]}
              style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "0.74rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", textDecoration: "none" }}
            >
              <CiDot status={ci.status} />
              {CI_LABEL[ci.status]}{ci.workflowName ? ` · ${ci.workflowName}` : ""}
            </a>
          ) : (
            <span title={CI_LABEL[ci.status]} style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "0.74rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
              <CiDot status={ci.status} />
              {CI_LABEL[ci.status]}{ci.workflowName ? ` · ${ci.workflowName}` : ""}
            </span>
          )
        )}

        {showPushed && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <Clock style={{ width: "11px", height: "11px" }} />
            pushed {pushedRel}
          </span>
        )}

        {prs.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            style={{
              display: "inline-flex", alignItems: "center", gap: "3px",
              marginLeft: "auto",
              background: "none", border: "none", cursor: "pointer",
              fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-body)",
            }}
          >
            {expanded ? <ChevronDown style={{ width: "12px", height: "12px" }} /> : <ChevronRight style={{ width: "12px", height: "12px" }} />}
            {expanded ? "Hide" : "Show"} PRs
          </button>
        )}
      </div>

      {expanded && prs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", paddingLeft: "18px" }}>
          {prs.map((pr) => {
            const sessionId = repo ? prSessionLinks?.[`${repo}#${pr.number}`] : undefined;
            return (
              <div key={pr.number} style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "0.74rem", color: "var(--text-secondary)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "5px" }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>#{pr.number}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "320px" }}>{pr.title}</span>
                </a>
                {pr.isDraft && (
                  <span style={{ fontSize: "0.6rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "0 4px" }}>
                    draft
                  </span>
                )}
                {pr.updatedAt && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    <Clock style={{ width: "9px", height: "9px" }} />
                    {formatRelativeTime(pr.updatedAt)}
                  </span>
                )}
                {sessionId && (
                  <Link
                    href={`/sessions/${sessionId}`}
                    title="Open the Claude session that created this PR"
                    style={{ fontSize: "0.65rem", color: "var(--info)", textDecoration: "none", fontFamily: "var(--font-mono)" }}
                  >
                    opened in session →
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
