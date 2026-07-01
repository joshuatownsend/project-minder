"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Terminal, Search, ChevronDown, ChevronRight } from "lucide-react";
import type { CommandEntry, LintFinding } from "@/lib/types";
import { commandsQuery } from "@/lib/queryOptions";
import { ApplyUnitButton } from "./ApplyUnitButton";
import { CatalogLintChip } from "@/components/CatalogLintChip";
import { CopyInvocationButton } from "@/components/CopyInvocationButton";
import { LintCountChip } from "@/components/ui/LintCountChip";
import { useLintFindings } from "@/hooks/useLintFindings";
import { truncate } from "@/lib/utils";

interface Row {
  entry: CommandEntry;
}

type SourceFilter = "all" | "user" | "plugin" | "project";

export function CommandsBrowser() {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const { data, isPending } = useQuery(
    commandsQuery(sourceFilter === "all" ? undefined : sourceFilter, undefined, query || undefined),
  );
  const visible = data ?? [];
  const { findingsByFile, projectSlugByFile } = useLintFindings();

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Terminal style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
        <h1
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
            margin: 0,
          }}
        >
          Commands
        </h1>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
          slash-command catalog · user · plugin · project
        </span>
      </header>

      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: "320px" }}>
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
            placeholder="Search commands…"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "5px 9px 5px 28px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: "2px" }}>
          {(["all", "user", "plugin", "project"] as SourceFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              style={{
                padding: "5px 10px",
                fontSize: "0.7rem",
                fontFamily: "var(--font-body)",
                background: sourceFilter === s ? "var(--info-bg)" : "transparent",
                color: sourceFilter === s ? "var(--info)" : "var(--text-secondary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                textTransform: "lowercase",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isPending && (
        <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
          loading…
        </div>
      )}
      {!isPending && visible.length === 0 && (
        <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
          no commands found
        </div>
      )}
      {visible.map((r) => (
        <CommandRow
          key={r.entry.id}
          row={r}
          expanded={expanded.has(r.entry.id)}
          onToggle={() => toggle(r.entry.id)}
          lintFindings={findingsByFile.get(r.entry.filePath) ?? []}
          lintProjectSlug={projectSlugByFile.get(r.entry.filePath)}
        />
      ))}
    </div>
  );
}

function CommandRow({
  row,
  expanded,
  onToggle,
  lintFindings = [],
  lintProjectSlug,
}: {
  row: Row;
  expanded: boolean;
  onToggle: () => void;
  lintFindings?: LintFinding[];
  lintProjectSlug?: string;
}) {
  const e = row.entry;
  const truncDesc = e.description ? truncate(e.description) : e.description;

  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}
        onClick={onToggle}
      >
        <span style={{ marginTop: "2px", color: "var(--text-muted)", flexShrink: 0 }}>
          {expanded ? (
            <ChevronDown style={{ width: "12px", height: "12px" }} />
          ) : (
            <ChevronRight style={{ width: "12px", height: "12px" }} />
          )}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "3px" }}>
            <span
              style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              /{e.slug}
            </span>
            {e.name !== e.slug && (
              <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>{e.name}</span>
            )}
            <SourceBadge entry={e} />
            {e.argumentHint && (
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.6rem",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "3px",
                  padding: "1px 4px",
                  color: "var(--text-muted)",
                }}
              >
                {e.argumentHint}
              </code>
            )}
            {e.provenance?.kind === "marketplace-plugin" &&
              e.provenance.pluginVersion &&
              e.provenance.pluginVersion !== "unknown" && (
                <Pill filled>v{e.provenance.pluginVersion}</Pill>
              )}
            {e.parseWarnings && e.parseWarnings.length > 0 && (
              <CatalogLintChip warnings={e.parseWarnings} />
            )}
            <LintCountChip findings={lintFindings} projectSlug={lintProjectSlug} />
            <CopyInvocationButton text={`/${e.slug}`} title={`Copy command invocation: /${e.slug}`} />
          </div>
          {truncDesc && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{truncDesc}</div>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginLeft: "20px", marginTop: "8px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {e.allowedTools && e.allowedTools.length > 0 && (
            <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              allowed-tools: {e.allowedTools.join(", ")}
            </div>
          )}
          <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {e.realPath ?? e.filePath}
          </div>
          {e.source !== "plugin" && (
            <div>
              <ApplyUnitButton
                unit={{ kind: "command", key: e.slug }}
                source={
                  e.source === "user"
                    ? { kind: "user" }
                    : { kind: "project", slug: e.projectSlug ?? "" }
                }
                excludeTargetSlugs={e.projectSlug ? [e.projectSlug] : []}
              />
            </div>
          )}
          {e.bodyExcerpt && (
            <pre
              style={{
                fontSize: "0.68rem",
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                padding: "8px",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "140px",
                overflow: "auto",
              }}
            >
              {e.bodyExcerpt}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function SourceBadge({ entry }: { entry: CommandEntry }) {
  if (entry.source === "user") {
    return <Pill>user</Pill>;
  }
  if (entry.source === "plugin") {
    return <Pill tone="info">plugin{entry.pluginName ? ` · ${entry.pluginName}` : ""}</Pill>;
  }
  return (
    <Link href={`/project/${entry.projectSlug}`} style={{ textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>
      <Pill tone="info">{entry.projectSlug}</Pill>
    </Link>
  );
}

function Pill({
  children,
  tone = "default",
  filled = false,
}: {
  children: React.ReactNode;
  tone?: "default" | "info";
  filled?: boolean;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: tone === "info" ? "var(--info)" : "var(--text-muted)",
        background: filled ? "var(--bg-surface)" : tone === "info" ? "var(--info-bg)" : "transparent",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
      }}
    >
      {children}
    </span>
  );
}
