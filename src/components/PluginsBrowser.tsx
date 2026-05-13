"use client";

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Box, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { usePlugins } from "@/hooks/usePlugins";
import { ApplyUnitButton } from "./ApplyUnitButton";
import type { PluginRollupRow } from "@/hooks/usePlugins";
import type { LintFinding } from "@/lib/types";
import { LintCountChip } from "@/components/ui/LintCountChip";
import { useLintFindings } from "@/hooks/useLintFindings";

const SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "invocations", label: "Invocations" },
] as const;
type SortBy = (typeof SORT_OPTIONS)[number]["value"];

function pluginRowKey(row: PluginRollupRow): string {
  return `${row.plugin.name}@${row.plugin.marketplace}`;
}

export function PluginsBrowser() {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const { data: plugins, loading, error } = usePlugins(query || undefined);
  const { findingsByFile } = useLintFindings();

  const sorted = [...plugins].sort((a, b) => {
    if (sortBy === "invocations") return b.totalInvocations - a.totalInvocations;
    return a.plugin.name.localeCompare(b.plugin.name);
  });

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 6,
    getItemKey: (i) => pluginRowKey(sorted[i]),
  });

  function toggleExpand(key: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Box style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
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
          Plugins
        </h1>
      </header>

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: "340px" }}>
          <Search
            style={{
              position: "absolute",
              left: "8px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "12px",
              height: "12px",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          />
          <input
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search plugins…"
            style={{
              width: "100%",
              padding: "6px 8px 6px 26px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              fontSize: "0.78rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          style={{
            padding: "5px 8px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: "0.75rem",
            fontFamily: "var(--font-body)",
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
            </option>
          ))}
        </select>

        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {sorted.length} plugin{sorted.length !== 1 ? "s" : ""}
        </span>
      </div>

      {error && (
        <div
          style={{
            padding: "8px 12px",
            background: "var(--error-bg, #2a0000)",
            borderRadius: "var(--radius)",
            fontSize: "0.78rem",
            color: "var(--error, #f87171)",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : sorted.length === 0 ? (
        <Empty query={rawQuery} />
      ) : (
        <div ref={parentRef} style={{ overflowY: "auto", maxHeight: "70vh" }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const row = sorted[vItem.index];
              const rowKey = pluginRowKey(row);
              const expanded = expandedIds.has(rowKey);
              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <PluginRow
                    row={row}
                    expanded={expanded}
                    onToggle={() => toggleExpand(rowKey)}
                    lintFindings={findingsByFile.get(
                      row.plugin.installPath ?? `plugin:${row.plugin.name}@${row.plugin.marketplace}`
                    ) ?? []}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PluginRow({
  row,
  expanded,
  onToggle,
  lintFindings = [],
}: {
  row: PluginRollupRow;
  expanded: boolean;
  onToggle: () => void;
  lintFindings?: LintFinding[];
}) {
  const { plugin, agentCount, skillCount, mcpServerCount, totalInvocations } = row;
  const status: "enabled" | "disabled" | "blocked" = plugin.blocked
    ? "blocked"
    : plugin.enabled
    ? "enabled"
    : "disabled";

  return (
    <div style={{ padding: "10px 0" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}
        onClick={onToggle}
      >
        <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>
          {expanded ? (
            <ChevronDown style={{ width: "12px", height: "12px" }} />
          ) : (
            <ChevronRight style={{ width: "12px", height: "12px" }} />
          )}
        </span>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "0.82rem",
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {plugin.name}
        </span>

        {plugin.marketplace && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            {plugin.marketplace}
          </span>
        )}

        {plugin.version && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            v{plugin.version}
          </span>
        )}

        {(agentCount > 0 || skillCount > 0 || mcpServerCount > 0) && (
          <span
            style={{
              fontSize: "0.68rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            {[
              agentCount > 0 && `${agentCount}a`,
              skillCount > 0 && `${skillCount}s`,
              mcpServerCount > 0 && `${mcpServerCount}m`,
            ].filter(Boolean).join(" · ")}
          </span>
        )}

        {totalInvocations > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              fontWeight: 600,
              padding: "1px 6px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "3px",
              color: "var(--text-secondary)",
              flexShrink: 0,
            }}
          >
            {totalInvocations.toLocaleString()}×
          </span>
        )}

        <StatusPill status={status} />

        <LintCountChip findings={lintFindings} />

        {plugin.enabled && (
          <ApplyUnitButton
            unit={{
              kind: "plugin",
              key: plugin.marketplace
                ? `${plugin.name}@${plugin.marketplace}`
                : plugin.name,
            }}
            source={{ kind: "user" }}
            compact
          />
        )}
      </div>

      {expanded && (
        <div
          style={{
            paddingLeft: "20px",
            paddingTop: "8px",
            paddingBottom: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          {agentCount > 0 && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
              <Link
                href={`/agents?source=plugin&q=${encodeURIComponent(plugin.name)}`}
                style={{ color: "var(--info)", textDecoration: "none" }}
              >
                {agentCount} agent{agentCount !== 1 ? "s" : ""}
              </Link>
            </div>
          )}
          {skillCount > 0 && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
              <Link
                href={`/skills?source=plugin&q=${encodeURIComponent(plugin.name)}`}
                style={{ color: "var(--info)", textDecoration: "none" }}
              >
                {skillCount} skill{skillCount !== 1 ? "s" : ""}
              </Link>
            </div>
          )}
          {mcpServerCount > 0 && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
              <Link
                href={`/config?type=mcp`}
                style={{ color: "var(--info)", textDecoration: "none" }}
              >
                {mcpServerCount} MCP server{mcpServerCount !== 1 ? "s" : ""}
              </Link>
            </div>
          )}
          {plugin.pluginRepoUrl && (
            <a
              href={plugin.pluginRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "0.68rem",
                color: "var(--text-muted)",
                textDecoration: "none",
              }}
            >
              <ExternalLink style={{ width: "10px", height: "10px" }} />
              Source
            </a>
          )}
          {agentCount === 0 && skillCount === 0 && mcpServerCount === 0 && (
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              No indexed catalog entries
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: "enabled" | "disabled" | "blocked" }) {
  const colors = {
    enabled: { bg: "var(--success-bg, #002a00)", text: "var(--success, #4ade80)" },
    disabled: { bg: "var(--surface-2)", text: "var(--text-muted)" },
    blocked: { bg: "var(--error-bg, #2a0000)", text: "var(--error, #f87171)" },
  }[status];
  return (
    <span
      style={{
        fontSize: "0.6rem",
        fontFamily: "var(--font-mono)",
        padding: "1px 5px",
        background: colors.bg,
        color: colors.text,
        border: "1px solid var(--border)",
        borderRadius: "3px",
        flexShrink: 0,
      }}
    >
      {status}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: "48px",
            borderRadius: "var(--radius)",
            background: "var(--surface-2)",
            opacity: 1 - i * 0.12,
          }}
        />
      ))}
    </div>
  );
}

function Empty({ query }: { query: string }) {
  return (
    <div
      style={{
        padding: "40px 0",
        textAlign: "center",
        color: "var(--text-muted)",
        fontSize: "0.8rem",
        fontFamily: "var(--font-body)",
      }}
    >
      {query ? `No plugins match "${query}"` : "No plugins installed."}
    </div>
  );
}
