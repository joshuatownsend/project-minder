"use client";
import { useState, useCallback, useEffect } from "react";
import { WorktreeOverlay, WorktreeStatus } from "@/lib/types";

interface WorktreePanelProps {
  slug: string;
  devPort?: number;
  worktrees: WorktreeOverlay[];
}

type SyncFile = "todos" | "manual-steps" | "insights";

interface DevServerState { running: boolean; port?: number; loading: boolean; }
interface SyncState { loading: boolean; result?: number; error?: string; }

interface WorktreeRowProps {
  wt: WorktreeOverlay;
  status: WorktreeStatus;
  parentSlug: string;
  parentDevPort?: number;
  onRemoved: () => void;
}

function worktreeSlugFor(parentSlug: string, branch: string) {
  return `${parentSlug}:wt:${branch.replace(/\//g, "-")}`;
}

function WorktreeRow({ wt, status, parentSlug, parentDevPort, onRemoved }: WorktreeRowProps) {
  const wtSlug = worktreeSlugFor(parentSlug, wt.branch);
  const [devServer, setDevServer] = useState<DevServerState>({ running: false, loading: false });
  const [serverAction, setServerAction] = useState<"starting" | "stopping" | null>(null);
  const [syncState, setSyncState] = useState<Record<SyncFile, SyncState>>({
    todos: { loading: false },
    "manual-steps": { loading: false },
    insights: { loading: false },
  });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const refreshDevServer = useCallback(async () => {
    setDevServer((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch(`/api/dev-server/${encodeURIComponent(wtSlug)}`);
      if (res.ok) {
        const data = await res.json();
        setDevServer({ running: data.running === true, port: data.port, loading: false });
      } else {
        setDevServer({ running: false, loading: false });
      }
    } catch {
      setDevServer({ running: false, loading: false });
    }
  }, [wtSlug]);

  useEffect(() => { refreshDevServer(); }, [refreshDevServer]);

  const handleStart = async () => {
    setServerAction("starting");
    try {
      const res = await fetch(`/api/worktrees/${parentSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start-server", worktreePath: wt.worktreePath, parentDevPort }),
      });
      if (res.ok) await refreshDevServer();
    } finally {
      setServerAction(null);
    }
  };

  const handleStop = async () => {
    setServerAction("stopping");
    try {
      await fetch(`/api/dev-server/${encodeURIComponent(wtSlug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await refreshDevServer();
    } finally {
      setServerAction(null);
    }
  };

  const handleSync = async (file: SyncFile) => {
    setSyncState((s) => ({ ...s, [file]: { loading: true } }));
    try {
      const res = await fetch(`/api/worktrees/${parentSlug}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreePath: wt.worktreePath, file }),
      });
      if (res.ok) {
        const data = await res.json();
        setSyncState((s) => ({ ...s, [file]: { loading: false, result: data.synced } }));
      } else {
        setSyncState((s) => ({ ...s, [file]: { loading: false, error: "Sync failed" } }));
      }
    } catch {
      setSyncState((s) => ({ ...s, [file]: { loading: false, error: "Network error" } }));
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/worktrees/${parentSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", worktreePath: wt.worktreePath }),
      });
      if (res.ok) {
        onRemoved();
      } else {
        const data = await res.json();
        setRemoveError(data.error ?? "Remove failed");
        setRemoving(false);
      }
    } catch {
      setRemoveError("Network error");
      setRemoving(false);
    }
  };

  const lastCommit = status.lastCommitDate
    ? new Date(status.lastCommitDate).toLocaleDateString()
    : null;

  const syncItems: { file: SyncFile; label: string; has: boolean }[] = [
    { file: "todos", label: "TODOs", has: (wt.todos?.total ?? 0) > 0 },
    { file: "manual-steps", label: "Manual Steps", has: (wt.manualSteps?.totalSteps ?? 0) > 0 },
    { file: "insights", label: "Insights", has: (wt.insights?.total ?? 0) > 0 },
  ];

  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      {/* Branch header */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
        <code style={{ fontSize: "0.78rem", color: "var(--text-primary)", background: "var(--bg-muted)", padding: "1px 6px", borderRadius: "3px" }}>
          {wt.branch}
        </code>
        {lastCommit && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{lastCommit}</span>}
        {status.isStale && (
          <span style={{ fontSize: "0.68rem", color: "var(--accent)", fontWeight: 500, marginLeft: "auto" }}>Stale</span>
        )}
      </div>

      {/* Dev server */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", width: "80px" }}>Dev server</span>
        {devServer.loading ? (
          <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>…</span>
        ) : devServer.running ? (
          <>
            <span style={{ fontSize: "0.72rem", color: "#4ade80", fontFamily: "var(--font-mono)" }}>
              ● :{devServer.port}
            </span>
            <a
              href={`http://localhost:${devServer.port}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}
              onClick={(e) => e.stopPropagation()}
            >
              localhost:{devServer.port}
            </a>
            <button
              onClick={handleStop}
              disabled={serverAction !== null}
              style={{ fontSize: "0.7rem", padding: "1px 8px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
            >
              {serverAction === "stopping" ? "…" : "Stop"}
            </button>
          </>
        ) : (
          <button
            onClick={handleStart}
            disabled={serverAction !== null}
            style={{ fontSize: "0.7rem", padding: "1px 8px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}
          >
            {serverAction === "starting" ? "Starting…" : "Start"}
          </button>
        )}
      </div>

      {/* Sync badges */}
      {syncItems.some((s) => s.has) && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }}>
          {syncItems.map(({ file, label, has }) => {
            if (!has) return null;
            const s = syncState[file];
            const done = s.result !== undefined;
            return (
              <div key={file} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{
                  fontSize: "0.68rem", padding: "1px 5px", borderRadius: "3px",
                  background: done ? "rgba(74,222,128,0.12)" : "rgba(245,158,11,0.12)",
                  color: done ? "#4ade80" : "var(--accent)",
                }}>
                  {done ? (s.result === 0 ? `${label} in sync` : `${label} +${s.result}`) : `${label} out of sync`}
                </span>
                {!done && (
                  <button
                    onClick={() => handleSync(file)}
                    disabled={s.loading}
                    style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}
                  >
                    {s.loading ? "…" : "Sync to parent"}
                  </button>
                )}
                {s.error && <span style={{ fontSize: "0.68rem", color: "var(--destructive)" }}>{s.error}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Remove (stale only) */}
      {status.isStale && !confirmRemove && (
        <button
          onClick={() => setConfirmRemove(true)}
          style={{ fontSize: "0.7rem", padding: "2px 10px", borderRadius: "3px", border: "1px solid var(--destructive)", background: "transparent", color: "var(--destructive)", cursor: "pointer" }}
        >
          Remove worktree
        </button>
      )}
      {confirmRemove && (
        <div style={{ marginTop: "6px", padding: "10px", background: "var(--bg-muted)", borderRadius: "var(--radius)", fontSize: "0.75rem" }}>
          <p style={{ margin: "0 0 6px", color: "var(--text-primary)" }}>
            Remove <code>{wt.branch}</code>?
            {status.uncommittedCount > 0 && (
              <span style={{ color: "var(--accent)" }}> Has {status.uncommittedCount} uncommitted changes.</span>
            )}
            {lastCommit && <span> Last commit {lastCommit}.</span>}
          </p>
          {removeError && <p style={{ margin: "0 0 6px", color: "var(--destructive)" }}>{removeError}</p>}
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              onClick={handleRemove}
              disabled={removing}
              style={{ fontSize: "0.7rem", padding: "2px 10px", borderRadius: "3px", border: "none", background: "var(--destructive)", color: "white", cursor: "pointer" }}
            >
              {removing ? "Removing…" : "Confirm Remove"}
            </button>
            <button
              onClick={() => { setConfirmRemove(false); setRemoveError(null); }}
              disabled={removing}
              style={{ fontSize: "0.7rem", padding: "2px 10px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorktreePanel({ slug, devPort, worktrees }: WorktreePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [statuses, setStatuses] = useState<WorktreeStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatuses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/worktrees/${slug}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatuses(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  const handleExpand = () => {
    if (!expanded && !statuses && !loading) fetchStatuses();
    setExpanded((x) => !x);
  };

  if (!worktrees || worktrees.length === 0) return null;

  return (
    <div>
      <button
        onClick={handleExpand}
        style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{expanded ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
          Worktrees ({worktrees.length})
        </span>
      </button>

      {expanded && (
        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {loading && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Loading…</span>}
          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--destructive)" }}>{error}</span>
              <button
                onClick={fetchStatuses}
                style={{ fontSize: "0.72rem", padding: "2px 8px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}
              >
                Retry
              </button>
            </div>
          )}
          {statuses && worktrees.map((wt, i) => (
            <WorktreeRow
              key={wt.worktreePath}
              wt={wt}
              status={statuses[i]}
              parentSlug={slug}
              parentDevPort={devPort}
              onRemoved={fetchStatuses}
            />
          ))}
        </div>
      )}
    </div>
  );
}
