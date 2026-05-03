"use client";

import { useEffect, useState } from "react";
import { Undo2, Loader2 } from "lucide-react";
import { useToast } from "./ToastProvider";

export interface HistoryEntry {
  id: string;
  timestamp: string;
  targetPath: string;
  contentSha: string;
  wasMissing: boolean;
  label?: string;
  projectSlug?: string;
  snapshotPath?: string;
}

export function ConfigHistoryTab({ projectSlug, projectPath }: { projectSlug: string; projectPath: string }) {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch(`/api/config-history?project=${encodeURIComponent(projectSlug)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { entries: HistoryEntry[] };
      setEntries(data.entries);
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug]);

  async function onRestore(id: string) {
    // Look up the entry's ISO timestamp for the toast — passing the
    // BackupId to shortTs would mangle the date because the id format
    // is "<iso-with-:->_<sha>_<rand>" and the round-trip back to ISO
    // is fragile (and pointless when the ISO is already in `entries`).
    const entryTs = entries?.find((e) => e.id === id)?.timestamp;
    setRestoring(id);
    try {
      const res = await fetch("/api/config-history/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupId: id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const tsLabel = entryTs ? shortTs(entryTs) : "snapshot";
      showToast("Restored", `${shortPath(body.restored?.targetPath ?? "", projectPath)} reverted to ${tsLabel}`);
      await refresh();
    } catch (e: unknown) {
      showToast("Restore failed", e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(null);
    }
  }

  if (loadError) {
    return (
      <div role="alert" style={alertStyle}>
        Couldn&apos;t load config history: {loadError}
      </div>
    );
  }

  if (entries === null) {
    return <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: "0.78rem" }}>Loading…</div>;
  }

  if (entries.length === 0) {
    return (
      <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        No config history for this project yet. Each apply from the Templates / Config browser will record a snapshot.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
      {entries.map((e) => (
        <div
          key={e.id}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: "10px",
            alignItems: "center",
            padding: "8px 12px",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            background: "var(--bg-surface)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
            }}
            title={e.timestamp}
          >
            {shortTs(e.timestamp)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.74rem",
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={e.targetPath}
            >
              {shortPath(e.targetPath, projectPath)}
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "2px", fontSize: "0.68rem", color: "var(--text-muted)" }}>
              {e.label && <span>{e.label}</span>}
              <span>{e.wasMissing ? "(file did not exist)" : `sha:${e.contentSha.slice(0, 8)}`}</span>
            </div>
          </div>
          <button
            onClick={() => onRestore(e.id)}
            disabled={restoring !== null}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 8px",
              fontSize: "0.7rem",
              color: "var(--text-secondary)",
              background: "transparent",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius)",
              cursor: restoring !== null ? "not-allowed" : "pointer",
              opacity: restoring !== null && restoring !== e.id ? 0.5 : 1,
            }}
            title={`Restore ${e.targetPath} to this snapshot`}
          >
            {restoring === e.id ? (
              <Loader2 style={{ width: "11px", height: "11px" }} className="animate-spin" />
            ) : (
              <Undo2 style={{ width: "11px", height: "11px" }} />
            )}
            Restore
          </button>
        </div>
      ))}
    </div>
  );
}

function shortPath(full: string, projectPath: string): string {
  if (!full) return "";
  if (full.startsWith(projectPath)) {
    return full.slice(projectPath.length).replace(/^[\\/]/, "");
  }
  return full;
}

function shortTs(iso: string): string {
  // Receives the entry's `timestamp` field (always an ISO string, never
  // a BackupId). Earlier versions accepted the id and tried to reverse
  // its `:` → `-` substitution; that was buggy because the id format is
  // "<iso>_<sha>_<rand>" and the regex didn't account for the trailing
  // suffix. Now that the only caller passes ISO directly, no conversion
  // is needed.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const alertStyle: React.CSSProperties = {
  padding: "10px 12px",
  border: "1px solid var(--accent-border)",
  background: "var(--accent-bg)",
  color: "var(--accent)",
  borderRadius: "var(--radius)",
  fontSize: "0.78rem",
};
