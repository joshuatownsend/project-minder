"use client";

import { useEffect, useState } from "react";
import { MinderConfig } from "@/lib/types";
import { Plus, Trash2, Save, RotateCcw, FolderOpen, Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { useToast } from "./ToastProvider";
import type { ReactNode } from "react";

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
      <span style={{
        fontSize: "0.62rem",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

function ConfigBlock({ children }: { children: ReactNode }) {
  return (
    <div style={{
      background: "var(--bg-surface)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)",
      overflow: "hidden",
    }}>
      {children}
    </div>
  );
}

function ConfigRow({ label, description, children, last }: {
  label: string;
  description?: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: "32px",
      padding: "14px 16px",
      borderBottom: last ? "none" : "1px solid var(--border-subtle)",
    }}>
      <div style={{ flex: "0 0 240px" }}>
        <div style={{
          fontSize: "0.8rem",
          fontWeight: 500,
          color: "var(--text-primary)",
          marginBottom: description ? "3px" : 0,
        }}>
          {label}
        </div>
        {description && (
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            {description}
          </div>
        )}
      </div>
      <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
        {children}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.78rem",
  padding: "5px 10px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: "auto",
  minWidth: "160px",
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
  paddingRight: "28px",
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 8px center",
};

const btnStyle = (variant: "primary" | "ghost" | "danger", disabled?: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  padding: "5px 12px",
  fontSize: "0.72rem",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  letterSpacing: "0.04em",
  borderRadius: "var(--radius)",
  cursor: disabled ? "not-allowed" : "pointer",
  border: "1px solid",
  opacity: disabled ? 0.5 : 1,
  transition: "background 0.1s, color 0.1s",
  ...(variant === "primary" ? {
    background: "var(--accent-bg)",
    color: "var(--accent)",
    borderColor: "var(--accent-border)",
  } : variant === "danger" ? {
    background: "transparent",
    color: "var(--status-error-text)",
    borderColor: "var(--status-error-border)",
  } : {
    background: "transparent",
    color: "var(--text-secondary)",
    borderColor: "var(--border-subtle)",
  }),
});

function ScanRootsEditor({
  roots,
  onChange,
}: {
  roots: string[];
  onChange: (roots: string[]) => void;
}) {
  const [newPath, setNewPath] = useState("");

  function addRoot() {
    const trimmed = newPath.trim();
    if (!trimmed || roots.includes(trimmed)) return;
    onChange([...roots, trimmed]);
    setNewPath("");
  }

  function removeRoot(i: number) {
    if (roots.length <= 1) return; // must keep at least one
    onChange(roots.filter((_, idx) => idx !== i));
  }

  function moveUp(i: number) {
    if (i === 0) return;
    const next = [...roots];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  }

  function moveDown(i: number) {
    if (i === roots.length - 1) return;
    const next = [...roots];
    [next[i], next[i + 1]] = [next[i + 1], next[i]];
    onChange(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%", maxWidth: "480px" }}>
      {roots.map((root, i) => (
        <div key={i} style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius)",
          padding: "4px 8px 4px 6px",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1px", opacity: 0.5 }}>
            <button
              onClick={() => moveUp(i)}
              disabled={i === 0}
              style={{ background: "none", border: "none", padding: "1px", cursor: i === 0 ? "default" : "pointer", color: "var(--text-muted)", opacity: i === 0 ? 0.3 : 1 }}
              title="Move up"
            >
              <ChevronUp style={{ width: "10px", height: "10px" }} />
            </button>
            <button
              onClick={() => moveDown(i)}
              disabled={i === roots.length - 1}
              style={{ background: "none", border: "none", padding: "1px", cursor: i === roots.length - 1 ? "default" : "pointer", color: "var(--text-muted)", opacity: i === roots.length - 1 ? 0.3 : 1 }}
              title="Move down"
            >
              <ChevronDown style={{ width: "10px", height: "10px" }} />
            </button>
          </div>

          <FolderOpen style={{ width: "11px", height: "11px", color: "var(--text-muted)", flexShrink: 0 }} />

          <span style={{
            flex: 1,
            fontFamily: "var(--font-mono)",
            fontSize: "0.75rem",
            color: i === 0 ? "var(--text-primary)" : "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {root}
          </span>

          {i === 0 && (
            <span style={{
              fontSize: "0.6rem",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--accent)",
              background: "var(--accent-bg)",
              border: "1px solid var(--accent-border)",
              borderRadius: "3px",
              padding: "1px 5px",
              flexShrink: 0,
            }}>
              primary
            </span>
          )}

          <button
            onClick={() => removeRoot(i)}
            disabled={roots.length <= 1}
            style={{
              background: "none",
              border: "none",
              padding: "3px",
              cursor: roots.length <= 1 ? "not-allowed" : "pointer",
              color: "var(--status-error-text)",
              opacity: roots.length <= 1 ? 0.3 : 0.7,
              flexShrink: 0,
            }}
            title={roots.length <= 1 ? "Cannot remove the last root" : "Remove root"}
          >
            <Trash2 style={{ width: "11px", height: "11px" }} />
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: "6px" }}>
        <input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addRoot(); }}
          placeholder="C:\\path\\to\\directory"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          onClick={addRoot}
          disabled={!newPath.trim()}
          style={{ ...btnStyle("ghost", !newPath.trim()), flexShrink: 0 }}
        >
          <Plus style={{ width: "11px", height: "11px" }} />
          Add
        </button>
      </div>
    </div>
  );
}

function HiddenProjectsList({
  hidden,
  onUnhide,
}: {
  hidden: string[];
  onUnhide: (dirName: string) => Promise<void>;
}) {
  const [unhiding, setUnhiding] = useState<string | null>(null);

  if (hidden.length === 0) {
    return (
      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
        No hidden projects.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", maxWidth: "480px" }}>
      {hidden.map((dirName) => (
        <div key={dirName} style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 10px",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
        }}>
          <span style={{
            flex: 1,
            fontFamily: "var(--font-mono)",
            fontSize: "0.75rem",
            color: "var(--text-secondary)",
          }}>
            {dirName}
          </span>
          <button
            onClick={async () => {
              setUnhiding(dirName);
              await onUnhide(dirName);
              setUnhiding(null);
            }}
            disabled={unhiding === dirName}
            style={btnStyle("ghost", unhiding === dirName)}
          >
            {unhiding === dirName ? (
              <Loader2 style={{ width: "10px", height: "10px", animation: "spin 1s linear infinite" }} />
            ) : (
              <RotateCcw style={{ width: "10px", height: "10px" }} />
            )}
            Unhide
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfigDashboard() {
  const [config, setConfig] = useState<MinderConfig | null>(null);
  const [draft, setDraft] = useState<MinderConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const isDirty = config && draft && JSON.stringify(config) !== JSON.stringify(draft);

  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: MinderConfig = await res.json();
      setConfig(data);
      setDraft(structuredClone(data));
    } catch (err) {
      showToast("Failed to load config", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadConfig(); }, []);

  async function saveSettings() {
    if (!draft || !isDirty) return;
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          devRoots: draft.devRoots ?? [draft.devRoot],
          scanBatchSize: draft.scanBatchSize,
          defaultSort: draft.defaultSort,
          defaultStatusFilter: draft.defaultStatusFilter,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { config: updated } = await res.json();
      setConfig(updated);
      setDraft(structuredClone(updated));
      showToast("Settings saved", "Rescan will pick up new roots on next load");
    } catch (err) {
      showToast("Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function unhideProject(dirName: string) {
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unhide", dirName }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Patch hidden list in both saved and draft state without a full refetch,
      // so any unsaved draft edits (e.g. root changes) are preserved.
      const removeHidden = (c: MinderConfig) => ({ ...c, hidden: c.hidden.filter((h) => h !== dirName) });
      setConfig((prev) => prev ? removeHidden(prev) : prev);
      setDraft((prev) => prev ? removeHidden(prev) : prev);
      showToast("Project unhidden", dirName);
    } catch (err) {
      showToast("Failed to unhide", err instanceof Error ? err.message : "Unknown error");
    }
  }

  function updateDraft(patch: Partial<MinderConfig>) {
    setDraft((prev) => prev ? { ...prev, ...patch } : prev);
  }

  if (loading || !draft) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "40px" }}>
        {[1, 2, 3].map((i) => (
          <div key={i}>
            <div style={{ height: "14px", width: "80px", background: "var(--bg-elevated)", borderRadius: "3px", marginBottom: "16px" }} />
            <div style={{ height: "120px", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)" }} />
          </div>
        ))}
      </div>
    );
  }

  const currentRoots = draft.devRoots && draft.devRoots.length > 0
    ? draft.devRoots
    : [draft.devRoot];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "40px" }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{
            fontSize: "1.1rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: 0,
            letterSpacing: "-0.01em",
          }}>
            Configuration
          </h1>
          <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "3px" }}>
            Changes to scan roots and behavior take effect on the next rescan.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {isDirty && (
            <button
              onClick={() => setDraft(structuredClone(config!))}
              style={btnStyle("ghost")}
            >
              <RotateCcw style={{ width: "11px", height: "11px" }} />
              Discard
            </button>
          )}
          <button
            onClick={saveSettings}
            disabled={!isDirty || saving}
            style={btnStyle("primary", !isDirty || saving)}
          >
            {saving ? (
              <Loader2 style={{ width: "11px", height: "11px", animation: "spin 1s linear infinite" }} />
            ) : (
              <Save style={{ width: "11px", height: "11px" }} />
            )}
            Save Changes
          </button>
        </div>
      </div>

      <section>
        <SectionHeader label="Scan Roots" />
        <ConfigBlock>
          <div style={{ padding: "16px" }}>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "12px", lineHeight: 1.6 }}>
              Directories Project Minder scans for git repositories. The first entry is the <strong style={{ color: "var(--text-secondary)" }}>primary root</strong> — it determines the default dev server base path and the header label. Add multiple roots to monitor projects across different drives or locations.
            </p>
            <ScanRootsEditor
              roots={currentRoots}
              onChange={(roots) => updateDraft({ devRoots: roots, devRoot: roots[0] })}
            />
          </div>
        </ConfigBlock>
      </section>

      <section>
        <SectionHeader label="Scan Behavior" />
        <ConfigBlock>
          <ConfigRow
            label="Batch size"
            description="Projects scanned in parallel per root. Lower values reduce CPU pressure during scans; higher values are faster on capable machines."
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="number"
                min={1}
                max={50}
                value={draft.scanBatchSize ?? 10}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1 && v <= 50) updateDraft({ scanBatchSize: v });
                }}
                style={{ ...inputStyle, width: "72px", textAlign: "center" }}
              />
              <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                / root (1–50)
              </span>
            </div>
          </ConfigRow>

          <ConfigRow
            label="Scan cache TTL"
            description="Project data is cached in memory for 5 minutes. This is not configurable but a rescan can be triggered manually."
            last
          >
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--text-muted)",
              padding: "5px 10px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
            }}>
              5 min (fixed)
            </span>
          </ConfigRow>
        </ConfigBlock>
      </section>

      <section>
        <SectionHeader label="Dashboard Defaults" />
        <ConfigBlock>
          <ConfigRow
            label="Default sort"
            description="Initial sort order on the project dashboard. You can still change it per session."
          >
            <div style={{ position: "relative", display: "inline-block" }}>
              <select
                value={draft.defaultSort ?? "activity"}
                onChange={(e) => updateDraft({ defaultSort: e.target.value as MinderConfig["defaultSort"] })}
                style={selectStyle}
              >
                <option value="activity">Last Activity</option>
                <option value="name">Name</option>
                <option value="claude">Claude Session</option>
              </select>
            </div>
          </ConfigRow>

          <ConfigRow
            label="Default status filter"
            description="Which project statuses are shown by default when you open the dashboard."
            last
          >
            <div style={{ position: "relative", display: "inline-block" }}>
              <select
                value={draft.defaultStatusFilter ?? "all"}
                onChange={(e) => updateDraft({ defaultStatusFilter: e.target.value as MinderConfig["defaultStatusFilter"] })}
                style={selectStyle}
              >
                <option value="all">All</option>
                <option value="active">Active only</option>
                <option value="paused">Paused only</option>
                <option value="archived">Archived only</option>
              </select>
            </div>
          </ConfigRow>
        </ConfigBlock>
      </section>

      <section>
        <SectionHeader label="Hidden Projects" />
        <ConfigBlock>
          <div style={{ padding: "16px" }}>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "12px", lineHeight: 1.6 }}>
              Projects hidden from the dashboard. These directories are skipped during scanning. Hide individual projects from their card menu; unhide them here.
            </p>
            <HiddenProjectsList
              hidden={draft.hidden}
              onUnhide={unhideProject}
            />
          </div>
        </ConfigBlock>
      </section>

    </div>
  );
}
