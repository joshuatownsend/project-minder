"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Send, Camera, Trash2 } from "lucide-react";
import type {
  TemplateManifest,
  TemplateUnitRef,
} from "@/lib/types";
import { ApplyTemplateModal } from "./ApplyTemplateModal";

interface Props {
  slug: string;
}

export function TemplateDetail({ slug }: Props) {
  const [manifest, setManifest] = useState<TemplateManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showApply, setShowApply] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/templates/${encodeURIComponent(slug)}`);
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          if (!cancelled) setError(j?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setManifest(data.manifest);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function onSnapshot() {
    if (!manifest || manifest.kind !== "live") return;
    if (!confirm(`Save "${manifest.name}" as a snapshot? This will copy the selected units into a frozen bundle.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "snapshot" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setManifest(data.manifest);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!manifest) return;
    if (!confirm(`Delete template "${manifest.name}"? This removes the manifest${manifest.kind === "snapshot" ? " and all bundled assets" : ""}.`)) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/templates/${encodeURIComponent(slug)}`, { method: "DELETE" });
      window.location.href = "/templates";
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div>
        <BackLink />
        <div style={{ padding: "20px 0", color: "var(--error, #ef4444)", fontSize: "0.78rem" }}>{error}</div>
      </div>
    );
  }
  if (!manifest) {
    return (
      <div>
        <BackLink />
        <div style={{ padding: "20px 0", color: "var(--text-muted)", fontSize: "0.78rem" }}>loading…</div>
      </div>
    );
  }

  const inv = manifest.units;
  const totalUnits =
    inv.agents.length + inv.skills.length + inv.commands.length + inv.hooks.length + inv.mcp.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <BackLink />

      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
        <div>
          <h1
            style={{
              fontSize: "1.1rem",
              margin: 0,
              fontFamily: "var(--font-body)",
              fontWeight: 700,
              color: "var(--text-primary)",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            {manifest.name}
            <KindBadge kind={manifest.kind} />
          </h1>
          <div style={{ marginTop: "6px", fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
            <code>{manifest.slug}</code>
            {manifest.kind === "live" && manifest.liveSourceSlug && (
              <span> · tracks <code>{manifest.liveSourceSlug}</code></span>
            )}
            <span> · updated {new Date(manifest.updatedAt).toLocaleString()}</span>
          </div>
          {manifest.description && (
            <p style={{ marginTop: "8px", color: "var(--text-secondary)", fontSize: "0.85rem", maxWidth: "60ch" }}>
              {manifest.description}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          <button onClick={() => setShowApply(true)} disabled={totalUnits === 0} style={primaryButton(totalUnits === 0)}>
            <Send style={{ width: "12px", height: "12px" }} /> apply…
          </button>
          {manifest.kind === "live" && (
            <button onClick={onSnapshot} disabled={busy} style={secondaryButton(busy)}>
              <Camera style={{ width: "12px", height: "12px" }} /> save as snapshot
            </button>
          )}
          <button onClick={onDelete} disabled={busy} style={dangerButton(busy)}>
            <Trash2 style={{ width: "12px", height: "12px" }} /> delete
          </button>
        </div>
      </header>

      <UnitList title="agents" refs={inv.agents} />
      <UnitList title="skills" refs={inv.skills} />
      <UnitList title="commands" refs={inv.commands} />
      <UnitList title="hooks" refs={inv.hooks} />
      <UnitList title="mcp servers" refs={inv.mcp} />
      <UnitList title="plugins (enable flag)" refs={inv.plugins} />
      <UnitList title="workflows (.github/workflows)" refs={inv.workflows} />

      {showApply && (
        <ApplyTemplateModal
          slug={manifest.slug}
          manifest={manifest}
          onClose={() => setShowApply(false)}
        />
      )}
    </div>
  );
}

function UnitList({ title, refs }: { title: string; refs: TemplateUnitRef[] }) {
  if (refs.length === 0) return null;
  return (
    <section>
      <div
        style={{
          fontSize: "0.62rem",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: "6px",
        }}
      >
        {title} ({refs.length})
      </div>
      {refs.map((r) => (
        <div
          key={`${r.kind}:${r.key}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "6px 0",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, fontSize: "0.78rem", color: "var(--text-primary)", fontWeight: 500 }}>
            {r.name ?? r.key}
          </span>
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}>
            {r.key.length > 60 ? r.key.slice(0, 56) + "…" : r.key}
          </code>
        </div>
      ))}
    </section>
  );
}

function KindBadge({ kind }: { kind: "live" | "snapshot" }) {
  const style: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "0.65rem",
    border: "1px solid var(--border-subtle)",
    borderRadius: "3px",
    padding: "2px 6px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: kind === "live" ? "var(--info)" : "var(--text-muted)",
    background: kind === "live" ? "var(--info-bg)" : "transparent",
  };
  return <span style={style}>{kind}</span>;
}

function BackLink() {
  return (
    <Link
      href="/templates"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "0.7rem",
        fontFamily: "var(--font-body)",
        color: "var(--text-muted)",
        textDecoration: "none",
      }}
    >
      <ArrowLeft style={{ width: "12px", height: "12px" }} /> back to templates
    </Link>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 10px",
    fontSize: "0.72rem",
    fontFamily: "var(--font-body)",
    background: "var(--accent)",
    color: "var(--bg-primary, white)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function secondaryButton(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 10px",
    fontSize: "0.72rem",
    fontFamily: "var(--font-body)",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function dangerButton(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 10px",
    fontSize: "0.72rem",
    fontFamily: "var(--font-body)",
    background: "transparent",
    color: "var(--error, #ef4444)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
