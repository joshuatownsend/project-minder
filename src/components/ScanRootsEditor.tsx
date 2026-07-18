"use client";

import { useState } from "react";
import { Plus, Trash2, FolderOpen, ChevronUp, ChevronDown } from "lucide-react";

// Shared between the /config Configuration page (ConfigDashboard) and the
// /settings Scan Roots section. Purely presentational: parent owns the list
// and persistence; the first entry is the primary root by convention.

const inputStyle: React.CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.78rem",
  padding: "5px 10px",
  outline: "none",
  boxSizing: "border-box",
};

const addBtnStyle = (disabled: boolean): React.CSSProperties => ({
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
  border: "1px solid var(--border-subtle)",
  opacity: disabled ? 0.5 : 1,
  background: "transparent",
  color: "var(--text-secondary)",
  flexShrink: 0,
});

export function ScanRootsEditor({
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
              aria-label={`Move ${root} up`}
            >
              <ChevronUp style={{ width: "10px", height: "10px" }} />
            </button>
            <button
              onClick={() => moveDown(i)}
              disabled={i === roots.length - 1}
              style={{ background: "none", border: "none", padding: "1px", cursor: i === roots.length - 1 ? "default" : "pointer", color: "var(--text-muted)", opacity: i === roots.length - 1 ? 0.3 : 1 }}
              title="Move down"
              aria-label={`Move ${root} down`}
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
            aria-label={roots.length <= 1 ? `Cannot remove the last root (${root})` : `Remove root ${root}`}
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
          placeholder={roots.some((r) => /^[A-Za-z]:/.test(r)) ? "C:\\path\\to\\directory" : "/path/to/directory"}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          onClick={addRoot}
          disabled={!newPath.trim()}
          style={addBtnStyle(!newPath.trim())}
        >
          <Plus style={{ width: "11px", height: "11px" }} />
          Add
        </button>
      </div>
    </div>
  );
}
