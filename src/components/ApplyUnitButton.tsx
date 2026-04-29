"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ApplyRequest,
  ApplyResult,
  ApplySource,
  ConflictPolicy,
  ProjectData,
  UnitKind,
  UnitRef,
} from "@/lib/types";

interface ApplyUnitButtonProps {
  unit: UnitRef;
  source: ApplySource;
  /** Project slugs to exclude from the target picker (typically the source project). */
  excludeTargetSlugs?: string[];
  /** Used to label the button — defaults to "↗ copy to project". */
  label?: string;
  /** Optional smaller-style override for inline-row contexts. */
  compact?: boolean;
}

/** Conflict policies per unit kind. Mirrors `applyFile.ts`/`applyHook.ts` accept-lists. */
function policiesFor(kind: UnitKind): ConflictPolicy[] {
  switch (kind) {
    case "hook":
    case "settingsKey":
      return ["skip", "overwrite", "merge"];
    case "plugin":
      return ["skip", "merge"];
    case "mcp":
      return ["skip", "overwrite", "merge", "rename"];
    case "agent":
    case "skill":
    case "command":
      return ["skip", "overwrite", "rename"];
    default:
      return ["skip"];
  }
}

export function ApplyUnitButton(props: ApplyUnitButtonProps) {
  const { unit, source, excludeTargetSlugs, label = "↗ copy to project", compact } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const buttonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    padding: "0 4px",
    fontSize: compact ? "0.6rem" : "0.62rem",
    fontFamily: "var(--font-body)",
    color: "var(--accent)",
    cursor: "pointer",
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        style={buttonStyle}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {label}
      </button>
      {open && (
        <ApplyPopover
          unit={unit}
          source={source}
          excludeTargetSlugs={excludeTargetSlugs}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

interface ApplyPopoverProps {
  unit: UnitRef;
  source: ApplySource;
  excludeTargetSlugs?: string[];
  onClose: () => void;
}

function ApplyPopover({ unit, source, excludeTargetSlugs, onClose }: ApplyPopoverProps) {
  const [projects, setProjects] = useState<ProjectData[] | null>(null);
  const [targetSlug, setTargetSlug] = useState<string>("");
  const policies = policiesFor(unit.kind);
  const [conflict, setConflict] = useState<ConflictPolicy>(policies[0]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [preview, setPreview] = useState<ApplyResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: { projects: ProjectData[] }) => {
        if (cancelled) return;
        const exclude = new Set(excludeTargetSlugs ?? []);
        const filtered = data.projects.filter((p) => !exclude.has(p.slug));
        setProjects(filtered);
        if (filtered[0]) setTargetSlug(filtered[0].slug);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [excludeTargetSlugs]);

  async function send(dryRun: boolean): Promise<ApplyResult | null> {
    if (!targetSlug) return null;
    const req: ApplyRequest = {
      unit,
      source,
      target: { kind: "existing", slug: targetSlug },
      conflict,
      dryRun,
    };
    setBusy(true);
    try {
      const res = await fetch("/api/claude-config/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data = (await res.json()) as ApplyResult;
      return data;
    } catch (e) {
      return {
        ok: false,
        status: "error",
        changedFiles: [],
        error: { code: "NETWORK", message: (e as Error).message },
      };
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
    // Auto-close only on a clean success — never when there are warnings
    // (the user needs to read them, e.g. local→project promotion or env
    // values to fill in). Errors always require manual dismissal too.
    const clean =
      r?.ok &&
      (r.status === "applied" || r.status === "merged") &&
      !(r.warnings && r.warnings.length > 0);
    if (clean) {
      setTimeout(onClose, 4000);
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        zIndex: 50,
        minWidth: "320px",
        maxWidth: "440px",
        background: "var(--bg-elevated, var(--bg-surface))",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        padding: "10px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
        fontFamily: "var(--font-body)",
        fontSize: "0.72rem",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          <span style={{ fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            target project
          </span>
          {!projects ? (
            <span style={{ color: "var(--text-muted)" }}>loading…</span>
          ) : projects.length === 0 ? (
            <span style={{ color: "var(--text-muted)" }}>no other projects available</span>
          ) : (
            <select
              value={targetSlug}
              onChange={(e) => setTargetSlug(e.target.value)}
              style={{
                padding: "4px 6px",
                fontSize: "0.72rem",
                background: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
              }}
            >
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name} ({p.slug})
                </option>
              ))}
            </select>
          )}
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          <span style={{ fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            on conflict
          </span>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {policies.map((p) => (
              <label key={p} style={{ display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" }}>
                <input
                  type="radio"
                  name={`conflict-${unit.kind}-${unit.key}`}
                  checked={conflict === p}
                  onChange={() => setConflict(p)}
                />
                <span>{p}</span>
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: "6px" }}>
          <button
            disabled={!targetSlug || busy}
            onClick={onPreview}
            style={popoverButtonStyle("secondary", busy || !targetSlug)}
          >
            {busy ? "…" : "preview diff"}
          </button>
          <button
            disabled={!targetSlug || busy}
            onClick={onApply}
            style={popoverButtonStyle("primary", busy || !targetSlug)}
          >
            {busy ? "applying…" : "apply"}
          </button>
        </div>

        {preview && <ResultBlock result={preview} mode="preview" onClose={onClose} />}
        {result && <ResultBlock result={result} mode="apply" onClose={onClose} />}
      </div>
    </div>
  );
}

function ResultBlock({
  result,
  mode,
  onClose,
}: {
  result: ApplyResult;
  mode: "preview" | "apply";
  onClose: () => void;
}) {
  const tone = !result.ok
    ? "error"
    : result.status === "skipped"
      ? "muted"
      : "ok";
  const headerColor =
    tone === "error" ? "var(--error, #ef4444)" : tone === "muted" ? "var(--text-muted)" : "var(--success, #10b981)";

  const summary = !result.ok
    ? `error · ${result.error?.code ?? "UNKNOWN"}`
    : `${mode === "preview" ? "would" : ""} ${result.status}`;

  return (
    <div
      style={{
        marginTop: "4px",
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: "6px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div style={{ fontSize: "0.62rem", color: headerColor, fontFamily: "var(--font-mono)" }}>
          {summary.trim()}
        </div>
        {mode === "apply" && (
          <button
            onClick={onClose}
            aria-label="dismiss"
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              padding: "2px 8px",
              fontSize: "0.6rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            close
          </button>
        )}
      </div>
      {result.error && (
        <div style={{ fontSize: "0.68rem", color: "var(--text-secondary)" }}>{result.error.message}</div>
      )}
      {result.warnings && result.warnings.length > 0 && (
        <ul
          style={{
            margin: 0,
            paddingLeft: "16px",
            fontSize: "0.65rem",
            color: "var(--warning, #f59e0b)",
          }}
        >
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {result.diffPreview && (
        <pre
          style={{
            margin: 0,
            padding: "6px",
            fontSize: "0.6rem",
            fontFamily: "var(--font-mono)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            maxHeight: "180px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {result.diffPreview}
        </pre>
      )}
      {result.changedFiles.length > 0 && mode === "apply" && (
        <div style={{ fontSize: "0.6rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {result.changedFiles.length} file{result.changedFiles.length === 1 ? "" : "s"} written
        </div>
      )}
    </div>
  );
}

function popoverButtonStyle(variant: "primary" | "secondary", disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    fontSize: "0.7rem",
    fontFamily: "var(--font-body)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    background: variant === "primary" ? "var(--accent)" : "transparent",
    color: variant === "primary" ? "var(--bg-primary, white)" : "var(--text-primary)",
    opacity: disabled ? 0.5 : 1,
  };
}
