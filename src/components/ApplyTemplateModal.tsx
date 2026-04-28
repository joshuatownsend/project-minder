"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ApplyTemplateRequest,
  ApplyTemplateResult,
  ConflictPolicy,
  ProjectData,
  TemplateManifest,
  TemplateUnitRef,
  UnitKind,
} from "@/lib/types";

interface Props {
  slug: string;
  manifest: TemplateManifest;
  onClose: () => void;
}

const POLICIES: ConflictPolicy[] = ["skip", "overwrite", "merge", "rename"];

/** Per-kind allowed policies. Mirrors the apply-primitives accept-lists.
 *  When a kind doesn't accept a policy it's surfaced as an error in the
 *  per-unit result row — but blocking the override at selection time is
 *  better UX than letting the user pick something that will fail. */
const POLICIES_BY_KIND: Record<UnitKind, ConflictPolicy[]> = {
  hook: ["skip", "overwrite", "merge"],
  mcp: ["skip", "overwrite", "merge", "rename"],
  agent: ["skip", "overwrite", "rename"],
  skill: ["skip", "overwrite", "rename"],
  command: ["skip", "overwrite", "rename"],
  plugin: ["skip", "overwrite", "merge"],
  workflow: ["skip", "overwrite", "rename"],
};

export function ApplyTemplateModal({ slug, manifest, onClose }: Props) {
  const [projects, setProjects] = useState<ProjectData[] | null>(null);
  const [targetMode, setTargetMode] = useState<"existing" | "new">("existing");
  const [existingSlug, setExistingSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newRelPath, setNewRelPath] = useState("");
  const [gitInit, setGitInit] = useState(true);
  const [conflict, setConflict] = useState<ConflictPolicy>("merge");
  const [perUnitConflict, setPerUnitConflict] = useState<Record<string, ConflictPolicy>>({});
  const [showOverrides, setShowOverrides] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ApplyTemplateResult | null>(null);
  const [result, setResult] = useState<ApplyTemplateResult | null>(null);

  const allUnits = useMemo<TemplateUnitRef[]>(
    () => [
      ...manifest.units.agents,
      ...manifest.units.skills,
      ...manifest.units.commands,
      ...manifest.units.hooks,
      ...manifest.units.mcp,
      ...manifest.units.plugins,
      ...manifest.units.workflows,
    ],
    [manifest]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      const res = await fetch("/api/projects");
      const data = (await res.json()) as { projects: ProjectData[] };
      if (cancelled) return;
      // Exclude the live source project — applying a live template back to its
      // own source is never the user's intent (and `merge` would be a no-op).
      const filtered = data.projects.filter((p) =>
        manifest.kind === "live" ? p.slug !== manifest.liveSourceSlug : true
      );
      setProjects(filtered);
      if (filtered[0]) setExistingSlug(filtered[0].slug);
    }
    loadProjects();
    return () => {
      cancelled = true;
    };
  }, [manifest.kind, manifest.liveSourceSlug]);

  // Auto-fill new-project relPath from name when user types.
  useEffect(() => {
    if (targetMode !== "new" || !newName) return;
    const slug = newName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    if (slug && !newRelPath) setNewRelPath(slug);
  }, [newName, newRelPath, targetMode]);

  function buildRequest(dryRun: boolean): ApplyTemplateRequest | null {
    const overrides = Object.keys(perUnitConflict).length > 0 ? perUnitConflict : undefined;
    if (targetMode === "existing") {
      if (!existingSlug) return null;
      return {
        templateSlug: slug,
        target: { kind: "existing", slug: existingSlug },
        conflictDefault: conflict,
        perUnitConflict: overrides,
        dryRun,
      };
    }
    if (!newName.trim() || !newRelPath.trim()) return null;
    return {
      templateSlug: slug,
      target: { kind: "new", name: newName.trim(), relPath: newRelPath.trim(), gitInit },
      conflictDefault: conflict,
      perUnitConflict: overrides,
      dryRun,
    };
  }

  async function send(dryRun: boolean): Promise<ApplyTemplateResult | null> {
    const req = buildRequest(dryRun);
    if (!req) return null;
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(slug)}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      return (await res.json()) as ApplyTemplateResult;
    } finally {
      setBusy(false);
    }
  }

  async function onPreview() {
    setResult(null);
    const r = await send(true);
    setPreview(r);
  }

  async function onApply() {
    setPreview(null);
    const r = await send(false);
    setResult(r);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-elevated, var(--bg-surface))",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          width: "min(560px, 100%)",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: "20px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
          fontFamily: "var(--font-body)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>
          Apply <code style={inlineCode}>{manifest.name}</code>
        </h2>
        <p style={{ marginTop: "4px", fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {manifest.kind} · {flatCount(manifest)} unit{flatCount(manifest) === 1 ? "" : "s"}
        </p>

        <fieldset style={{ marginTop: "12px", border: "none", padding: 0 }}>
          <legend style={legend}>target</legend>
          <div style={{ display: "flex", gap: "12px", marginBottom: "8px" }}>
            <label style={radioLabel}>
              <input
                type="radio"
                checked={targetMode === "existing"}
                onChange={() => setTargetMode("existing")}
              />
              <span>existing project</span>
            </label>
            <label style={radioLabel}>
              <input
                type="radio"
                checked={targetMode === "new"}
                onChange={() => setTargetMode("new")}
              />
              <span>new project (mkdir + git init)</span>
            </label>
          </div>

          {targetMode === "existing" ? (
            !projects ? (
              <span style={mutedText}>loading projects…</span>
            ) : projects.length === 0 ? (
              <span style={mutedText}>no eligible target projects</span>
            ) : (
              <select
                value={existingSlug}
                onChange={(e) => setExistingSlug(e.target.value)}
                style={inputStyle}
              >
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name} ({p.slug})
                  </option>
                ))}
              </select>
            )
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <label style={labelStyle}>
                <span style={subLabel}>name</span>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. fresh-app"
                  style={inputStyle}
                />
              </label>
              <label style={labelStyle}>
                <span style={subLabel}>relative path under devRoot</span>
                <input
                  type="text"
                  value={newRelPath}
                  onChange={(e) => setNewRelPath(e.target.value)}
                  placeholder="e.g. fresh-app"
                  style={inputStyle}
                />
              </label>
              <label style={radioLabel}>
                <input
                  type="checkbox"
                  checked={gitInit}
                  onChange={(e) => setGitInit(e.target.checked)}
                />
                <span>run <code style={inlineCode}>git init</code> after mkdir</span>
              </label>
            </div>
          )}
        </fieldset>

        <fieldset style={{ marginTop: "12px", border: "none", padding: 0 }}>
          <legend style={legend}>default conflict policy</legend>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {POLICIES.map((p) => (
              <label key={p} style={radioLabel}>
                <input type="radio" checked={conflict === p} onChange={() => setConflict(p)} />
                <span>{p}</span>
              </label>
            ))}
          </div>
          <p style={{ marginTop: "4px", fontSize: "0.65rem", color: "var(--text-muted)" }}>
            applied to all units. some unit kinds reject some policies (e.g., hooks can&apos;t rename) — those are hidden
            from the per-unit override below.
          </p>
        </fieldset>

        {allUnits.length > 0 && (
          <fieldset style={{ marginTop: "12px", border: "none", padding: 0 }}>
            <legend
              style={{
                ...legend,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
              onClick={() => setShowOverrides((v) => !v)}
            >
              <span aria-hidden="true">{showOverrides ? "▾" : "▸"}</span>
              per-unit overrides {Object.keys(perUnitConflict).length > 0 && `(${Object.keys(perUnitConflict).length})`}
            </legend>
            {showOverrides && (
              <div
                style={{
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius)",
                  maxHeight: "180px",
                  overflowY: "auto",
                  marginTop: "4px",
                }}
              >
                {allUnits.map((u) => {
                  const id = `${u.kind}:${u.key}`;
                  const allowed = POLICIES_BY_KIND[u.kind];
                  const current = perUnitConflict[id];
                  return (
                    <div
                      key={id}
                      style={{
                        display: "flex",
                        gap: "8px",
                        alignItems: "center",
                        padding: "4px 8px",
                        borderBottom: "1px solid var(--border-subtle)",
                        fontSize: "0.7rem",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.6rem",
                          color: "var(--text-muted)",
                          minWidth: "55px",
                        }}
                      >
                        {u.kind}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {u.name ?? u.key}
                      </span>
                      <select
                        value={current ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPerUnitConflict((prev) => {
                            const next = { ...prev };
                            if (v === "") delete next[id];
                            else next[id] = v as ConflictPolicy;
                            return next;
                          });
                        }}
                        style={{
                          padding: "2px 6px",
                          fontSize: "0.65rem",
                          fontFamily: "var(--font-body)",
                          background: "var(--bg-surface)",
                          color: "var(--text-primary)",
                          border: "1px solid var(--border-subtle)",
                          borderRadius: "var(--radius)",
                        }}
                      >
                        <option value="">(default)</option>
                        {allowed.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </fieldset>
        )}

        <div style={{ marginTop: "16px", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={secondaryButton(busy)}>
            cancel
          </button>
          <button onClick={onPreview} disabled={busy} style={secondaryButton(busy)}>
            {busy ? "…" : "preview"}
          </button>
          <button onClick={onApply} disabled={busy} style={primaryButton(busy)}>
            {busy ? "applying…" : "apply"}
          </button>
        </div>

        {preview && <ResultBlock result={preview} mode="preview" />}
        {result && <ResultBlock result={result} mode="apply" />}
      </div>
    </div>
  );
}

function ResultBlock({ result, mode }: { result: ApplyTemplateResult; mode: "preview" | "apply" }) {
  return (
    <div
      style={{
        marginTop: "14px",
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: "10px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      }}
    >
      <div style={{ fontSize: "0.78rem", fontWeight: 600 }}>
        {mode === "preview" ? "preview" : "result"}{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontWeight: 400, fontSize: "0.7rem" }}>
          · {summarize(result.summary, mode)}
        </span>
      </div>
      {result.error && (
        <div style={{ color: "var(--error, #ef4444)", fontSize: "0.72rem" }}>
          {result.error.code}: {result.error.message}
        </div>
      )}
      {result.bootstrap && (
        <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
          new project at <code style={inlineCode}>{result.bootstrap.createdPath}</code>
          {result.bootstrap.gitInitialized ? " · git initialized" : " · git init skipped"}
        </div>
      )}
      {result.results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "3px", marginTop: "4px" }}>
          {result.results.map((r, i) => (
            <UnitResultRow key={`${r.unit.kind}:${r.unit.key}:${i}`} unit={r.unit} result={r.result} />
          ))}
        </div>
      )}
    </div>
  );
}

function UnitResultRow({
  unit,
  result,
}: {
  unit: { kind: string; key: string; name?: string };
  result: ApplyTemplateResult["results"][number]["result"];
}) {
  const tone = !result.ok
    ? "error"
    : result.status === "skipped"
      ? "muted"
      : "ok";
  const color =
    tone === "error" ? "var(--error, #ef4444)" : tone === "muted" ? "var(--text-muted)" : "var(--success, #10b981)";
  const status = result.ok ? result.status : `error · ${result.error?.code ?? "UNKNOWN"}`;

  return (
    <div
      style={{
        display: "flex",
        gap: "8px",
        alignItems: "center",
        fontSize: "0.7rem",
        padding: "3px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          border: "1px solid var(--border-subtle)",
          borderRadius: "3px",
          padding: "1px 4px",
          color: "var(--text-muted)",
          minWidth: "55px",
          textAlign: "center",
        }}
      >
        {unit.kind}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {unit.name ?? unit.key}
      </span>
      {result.warnings && result.warnings.length > 0 && (
        <span title={result.warnings.join("; ")} style={{ color: "var(--warning, #f59e0b)", fontSize: "0.6rem" }}>
          ⚠ {result.warnings.length}
        </span>
      )}
      <span style={{ color, fontFamily: "var(--font-mono)", fontSize: "0.65rem" }}>{status}</span>
    </div>
  );
}

function summarize(s: ApplyTemplateResult["summary"], mode: "preview" | "apply"): string {
  const parts: string[] = [];
  if (mode === "preview") parts.push(`${s.wouldApply} would apply`);
  else {
    if (s.applied > 0) parts.push(`${s.applied} applied`);
    if (s.merged > 0) parts.push(`${s.merged} merged`);
  }
  if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  if (s.errors > 0) parts.push(`${s.errors} errors`);
  return parts.length === 0 ? "no changes" : parts.join(", ");
}

function flatCount(m: TemplateManifest): number {
  return m.units.agents.length + m.units.skills.length + m.units.commands.length + m.units.hooks.length + m.units.mcp.length;
}

const inlineCode: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.72rem",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "3px",
  padding: "1px 4px",
};

const legend: React.CSSProperties = {
  fontSize: "0.62rem",
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: 0,
  marginBottom: "6px",
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "3px",
};

const subLabel: React.CSSProperties = {
  fontSize: "0.62rem",
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const radioLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontSize: "0.72rem",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  fontSize: "0.78rem",
  fontFamily: "var(--font-body)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  boxSizing: "border-box",
};

const mutedText: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--text-muted)",
};

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    fontSize: "0.74rem",
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
    padding: "5px 12px",
    fontSize: "0.74rem",
    fontFamily: "var(--font-body)",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
