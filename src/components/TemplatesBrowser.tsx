"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers } from "lucide-react";
import type { TemplateManifest } from "@/lib/types";

interface ListResponse {
  manifests: TemplateManifest[];
  errors: Array<{ slug: string; reason: string }>;
}

export function TemplatesBrowser() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/templates");
        const json = (await res.json()) as ListResponse;
        if (!cancelled) setData(json);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Layers style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
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
          Templates
        </h1>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
          curated bundles · live or snapshot · apply across projects
        </span>
      </header>

      {loading && <div style={mutedRow}>loading…</div>}

      {!loading && data && data.manifests.length === 0 && data.errors.length === 0 && (
        <div style={emptyState}>
          <strong style={{ display: "block", marginBottom: "6px" }}>No templates yet.</strong>
          To create one: pick a project on the dashboard, open its three-dot menu, and choose
          &ldquo;Mark as template…&rdquo; — or use the API to POST a manifest. Templates live at{" "}
          <code style={inlineCode}>&lt;devRoot&gt;/.minder/templates/&lt;slug&gt;/</code>.
        </div>
      )}

      {!loading && data && data.manifests.length > 0 && (
        <div>
          {data.manifests.map((m) => (
            <TemplateRow key={m.slug} manifest={m} />
          ))}
        </div>
      )}

      {!loading && data && data.errors.length > 0 && (
        <div style={errorsBlock}>
          <div style={{ fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>
            invalid manifests ({data.errors.length})
          </div>
          {data.errors.map((e) => (
            <div key={e.slug} style={{ fontSize: "0.7rem", color: "var(--warning, #f59e0b)" }}>
              <code style={inlineCode}>{e.slug}</code> — {e.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateRow({ manifest }: { manifest: TemplateManifest }) {
  const inv = manifest.units;
  const totalUnits =
    inv.agents.length +
    inv.skills.length +
    inv.commands.length +
    inv.hooks.length +
    inv.mcp.length +
    inv.plugins.length +
    inv.workflows.length +
    inv.settings.length;

  return (
    <Link
      href={`/templates/${encodeURIComponent(manifest.slug)}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "9px 0",
        borderBottom: "1px solid var(--border-subtle)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "var(--text-primary)",
              fontFamily: "var(--font-body)",
            }}
          >
            {manifest.name}
          </span>
          <KindBadge kind={manifest.kind} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}>
            {manifest.slug}
          </span>
        </div>
        {manifest.description && (
          <div
            style={{
              fontSize: "0.7rem",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {manifest.description}
          </div>
        )}
        <div style={{ display: "flex", gap: "8px", fontSize: "0.6rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
          <span>{totalUnits} unit{totalUnits === 1 ? "" : "s"}</span>
          {inv.agents.length > 0 && <span>· {inv.agents.length} agent{inv.agents.length === 1 ? "" : "s"}</span>}
          {inv.skills.length > 0 && <span>· {inv.skills.length} skill{inv.skills.length === 1 ? "" : "s"}</span>}
          {inv.commands.length > 0 && <span>· {inv.commands.length} command{inv.commands.length === 1 ? "" : "s"}</span>}
          {inv.hooks.length > 0 && <span>· {inv.hooks.length} hook{inv.hooks.length === 1 ? "" : "s"}</span>}
          {inv.mcp.length > 0 && <span>· {inv.mcp.length} mcp</span>}
          {inv.plugins.length > 0 && <span>· {inv.plugins.length} plugin{inv.plugins.length === 1 ? "" : "s"}</span>}
          {inv.workflows.length > 0 && <span>· {inv.workflows.length} workflow{inv.workflows.length === 1 ? "" : "s"}</span>}
          {inv.settings.length > 0 && <span>· {inv.settings.length} setting{inv.settings.length === 1 ? "" : "s"}</span>}
          {manifest.kind === "live" && manifest.liveSourceSlug && (
            <span>· tracks <strong>{manifest.liveSourceSlug}</strong></span>
          )}
        </div>
      </div>
    </Link>
  );
}

function KindBadge({ kind }: { kind: "live" | "snapshot" }) {
  const style: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    border: "1px solid var(--border-subtle)",
    borderRadius: "3px",
    padding: "1px 5px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: kind === "live" ? "var(--info)" : "var(--text-muted)",
    background: kind === "live" ? "var(--info-bg)" : "transparent",
  };
  return <span style={style}>{kind}</span>;
}

const mutedRow: React.CSSProperties = {
  padding: "20px 0",
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: "0.78rem",
};

const emptyState: React.CSSProperties = {
  padding: "20px 16px",
  border: "1px dashed var(--border-subtle)",
  borderRadius: "var(--radius)",
  color: "var(--text-secondary)",
  fontSize: "0.78rem",
  lineHeight: 1.6,
};

const errorsBlock: React.CSSProperties = {
  padding: "10px 12px",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  background: "var(--bg-surface)",
  display: "flex",
  flexDirection: "column",
  gap: "3px",
};

const inlineCode: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.7rem",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "3px",
  padding: "1px 4px",
};
