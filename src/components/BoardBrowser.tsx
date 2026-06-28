"use client";

import { useState, useEffect } from "react";
import { useAllBoards, BoardProjectView } from "@/hooks/useBoard";
import { BoardEpic, BoardIssue, BoardStatus } from "@/lib/types";
import { LayoutDashboard, Search, Inbox } from "lucide-react";
import Link from "next/link";
import {
  StatusChip,
  PriorityChip,
  LabelChips,
  ProvenanceChips,
} from "./BoardChips";

const STATUS_OPTIONS: BoardStatus[] = [
  "backlog",
  "todo",
  "doing",
  "review",
  "done",
  "triage",
];

// ── Single issue row ───────────────────────────────────────────────────────
function IssueRow({ issue, slug }: { issue: BoardIssue; slug: string }) {
  return (
    <Link
      href={`/project/${slug}`}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "7px",
        padding: "6px 0",
        borderBottom: "1px solid var(--border-subtle)",
        textDecoration: "none",
        flexWrap: "wrap",
      }}
    >
      <StatusChip status={issue.status} />
      <span
        style={{
          fontSize: "0.8rem",
          color:
            issue.status === "done" ? "var(--text-muted)" : "var(--text-primary)",
          textDecoration: issue.status === "done" ? "line-through" : "none",
        }}
      >
        {issue.title}
      </span>
      <PriorityChip priority={issue.priority} />
      <LabelChips labels={issue.labels} />
      <ProvenanceChips worktree={issue.worktree} sessionId={issue.sessionId} />
    </Link>
  );
}

// ── Epic block (header + its issues) ───────────────────────────────────────
function EpicBlock({ epic, slug }: { epic: BoardEpic; slug: string }) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "7px",
          padding: "8px 0 4px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: "0.78rem",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {epic.title || "(untitled epic)"}
        </span>
        <StatusChip status={epic.status} />
        <PriorityChip priority={epic.priority} />
        <LabelChips labels={epic.labels} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--text-muted)",
          }}
        >
          {epic.issues.length}
        </span>
      </div>
      {epic.issues.length > 0 && (
        <div style={{ paddingLeft: "14px" }}>
          {epic.issues.map((issue, i) => (
            <IssueRow key={issue.id || `${epic.id}-${i}`} issue={issue} slug={slug} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Per-project section ────────────────────────────────────────────────────
function ProjectSection({ project }: { project: BoardProjectView }) {
  const { slug, name, board } = project;
  return (
    <div>
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          paddingBottom: "8px",
        }}
      >
        <Link
          href={`/project/${slug}`}
          style={{
            fontSize: "0.78rem",
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            textDecoration: "none",
          }}
        >
          {name}
        </Link>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--text-muted)",
          }}
        >
          {board.total}
        </span>
        <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
      </div>

      <div style={{ paddingLeft: "4px" }}>
        {board.epics.map((epic, i) => (
          <EpicBlock key={epic.id || `epic-${i}`} epic={epic} slug={slug} />
        ))}

        {/* Inbox lane */}
        {board.inbox.length > 0 && (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 0 4px",
              }}
            >
              <Inbox
                style={{ width: "12px", height: "12px", color: "var(--text-muted)" }}
              />
              <span
                style={{
                  fontSize: "0.74rem",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                Inbox
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.62rem",
                  color: "var(--text-muted)",
                }}
              >
                {board.inbox.length}
              </span>
            </div>
            <div style={{ paddingLeft: "14px" }}>
              {board.inbox.map((issue, i) => (
                <IssueRow key={issue.id || `inbox-${i}`} issue={issue} slug={slug} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main browser ───────────────────────────────────────────────────────────
export function BoardBrowser() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, loading } = useAllBoards(
    projectFilter || undefined,
    statusFilter || undefined,
    debouncedSearch || undefined,
  );

  // Project options come from the unfiltered set, so the dropdown stays stable
  // while a status/search filter narrows the visible projects.
  const [allProjectOpts, setAllProjectOpts] = useState<
    { slug: string; name: string }[]
  >([]);
  useEffect(() => {
    if (!projectFilter && !statusFilter && !debouncedSearch) {
      setAllProjectOpts(
        data.projects.map((p) => ({ slug: p.slug, name: p.name })),
      );
    }
  }, [data.projects, projectFilter, statusFilter, debouncedSearch]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <LayoutDashboard
          style={{ width: "14px", height: "14px", color: "var(--text-muted)" }}
        />
        <h1
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
          }}
        >
          Board
        </h1>
        {data.totalIssues > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-muted)",
            }}
          >
            {data.totalIssues} issue{data.totalIssues !== 1 ? "s" : ""}
            {data.totalEpics > 0 ? ` · ${data.totalEpics} epics` : ""}
          </span>
        )}
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: "160px" }}>
          <Search
            style={{
              position: "absolute",
              left: "9px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "13px",
              height: "13px",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          />
          <input
            type="text"
            placeholder="Search issues…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              height: "32px",
              paddingLeft: "30px",
              paddingRight: "10px",
              fontSize: "0.78rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-primary)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius)",
              outline: "none",
            }}
          />
        </div>

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            height: "32px",
            padding: "0 10px",
            fontSize: "0.72rem",
            fontFamily: "var(--font-body)",
            color: "var(--text-secondary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            outline: "none",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {/* Project filter */}
        {allProjectOpts.length > 1 && (
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            style={{
              height: "32px",
              padding: "0 10px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-secondary)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              outline: "none",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <option value="">All projects</option>
            {allProjectOpts.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              style={{
                height: "72px",
                background: "var(--bg-surface)",
                borderRadius: "var(--radius)",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      ) : data.projects.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "48px 0",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <LayoutDashboard
            style={{
              width: "28px",
              height: "28px",
              color: "var(--text-muted)",
              opacity: 0.4,
            }}
          />
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {search || statusFilter || projectFilter
              ? "No issues match your filters."
              : "No boards yet."}
          </p>
          {!(search || statusFilter || projectFilter) && (
            <p
              style={{
                fontSize: "0.72rem",
                color: "var(--text-muted)",
                opacity: 0.6,
                maxWidth: "360px",
              }}
            >
              Add a <code>BOARD.md</code> to a project (epics → issues) and it
              shows up here. See the help doc for the grammar.
            </p>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {data.projects.map((project) => (
            <ProjectSection key={project.slug} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
