"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "./ui/button";
import { Play, Square, RotateCw, Terminal, ExternalLink } from "lucide-react";
import { useToast } from "./ToastProvider";

interface DevServerInfo {
  slug: string;
  pid: number;
  port?: number;
  command: string;
  startedAt: string;
  status: "starting" | "running" | "stopped" | "errored";
  output: string[];
}

interface DevServerControlProps {
  slug: string;
  projectPath: string;
  devPort?: number;
  compact?: boolean;
}

const statusTokens: Record<string, { color: string; bg: string; border: string }> = {
  starting: { color: "var(--info)",                bg: "var(--info-bg)",               border: "var(--info-border)"               },
  running:  { color: "var(--status-active-text)",  bg: "var(--status-active-bg)",       border: "var(--status-active-border)"      },
  stopped:  { color: "var(--status-archived-text)",bg: "var(--status-archived-bg)",     border: "var(--status-archived-border)"    },
  errored:  { color: "var(--status-error-text)",   bg: "var(--status-error-bg)",        border: "var(--status-error-border)"       },
};

function StatusPill({ status }: { status: string }) {
  const t = statusTokens[status] ?? statusTokens.stopped;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      fontFamily: "var(--font-mono)", fontSize: "0.65rem", fontWeight: 600,
      letterSpacing: "0.06em", textTransform: "uppercase",
      color: t.color, background: t.bg, border: `1px solid ${t.border}`,
      borderRadius: "3px", padding: "2px 8px", lineHeight: 1.4,
    }}>
      {status}
    </span>
  );
}

export function DevServerControl({
  slug,
  projectPath,
  devPort,
  compact = false,
}: DevServerControlProps) {
  const [server, setServer] = useState<DevServerInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { showToast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/dev-server/${slug}`);
      const data = await res.json();
      if (data.command) {
        setServer(data);
      } else {
        setServer(null);
      }
    } catch {
      // ignore
    }
  }, [slug]);

  // Poll for status when server is running/starting
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    const shouldPoll = server?.status === "running" || server?.status === "starting";
    if (shouldPoll) {
      pollRef.current = setInterval(fetchStatus, 2000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [server?.status, fetchStatus]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current && showOutput) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [server?.output?.length, showOutput]);

  const doAction = async (action: "start" | "stop" | "restart") => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dev-server/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, projectPath, port: devPort }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      if (data.command) {
        setServer(data);
        if (action === "start" || action === "restart") {
          setShowOutput(true);
        }
      } else {
        setServer(null);
      }
    } catch {
      showToast(`Failed to ${action} dev server`);
    } finally {
      setLoading(false);
    }
  };

  const isActive =
    server?.status === "running" || server?.status === "starting";
  const port = server?.port || devPort;

  if (compact) {
    if (isActive) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.68rem",
              fontWeight: 500,
              color: "var(--running-text)",
              background: "var(--running-bg)",
              border: "1px solid var(--status-active-border)",
              borderRadius: "3px",
              padding: "2px 6px",
              lineHeight: 1.4,
            }}
          >
            {server!.status === "starting" ? "starting…" : `●  :${port || "?"}`}
          </span>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); doAction("stop"); }}
            disabled={loading}
            title="Stop dev server"
            aria-label="Stop dev server"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "28px", height: "28px",
              background: "transparent",
              border: "1px solid var(--border-default)",
              borderRadius: "3px",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <Square style={{ width: "9px", height: "9px" }} />
          </button>
        </div>
      );
    }

    // Stopped state — always rendered, disabled if no port configured
    const canStart = !!devPort;
    return (
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (canStart) doAction("start");
        }}
        disabled={loading || !canStart}
        title={canStart ? "Start dev server" : "No port configured"}
        style={{
          display: "flex", alignItems: "center", gap: "4px",
          padding: "3px 8px",
          fontSize: "0.7rem",
          fontFamily: "var(--font-body)",
          fontWeight: 500,
          color: canStart ? "var(--text-secondary)" : "var(--text-disabled)",
          background: "transparent",
          border: "1px solid var(--border-subtle)",
          borderRadius: "3px",
          cursor: canStart ? "pointer" : "default",
          opacity: canStart ? 1 : 0.4,
          transition: "color 0.12s, border-color 0.12s",
        }}
      >
        <Play style={{ width: "9px", height: "9px" }} />
        Start
      </button>
    );
  }

  return (
    <div style={{
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-subtle)",
      padding: "16px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      background: "var(--bg-surface)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{
          display: "flex", alignItems: "center", gap: "8px",
          fontFamily: "var(--font-body)", fontWeight: 500, fontSize: "0.875rem",
          color: "var(--text-primary)", margin: 0,
        }}>
          <Terminal style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
          Dev Server
        </h3>
        <StatusPill status={server?.status ?? "stopped"} />
      </div>

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        {!isActive ? (
          <Button variant="default" size="sm" onClick={() => doAction("start")} disabled={loading}>
            <Play className="h-4 w-4 mr-1" />
            {loading ? "Starting…" : "Start"}
          </Button>
        ) : (
          <>
            <Button variant="destructive" size="sm" onClick={() => doAction("stop")} disabled={loading}>
              <Square className="h-4 w-4 mr-1" />
              Stop
            </Button>
            <Button variant="outline" size="sm" onClick={() => doAction("restart")} disabled={loading}>
              <RotateCw className="h-4 w-4 mr-1" />
              Restart
            </Button>
            {port && (
              <Button variant="outline" size="sm" onClick={() => window.open(`http://localhost:${port}`, "_blank")}>
                <ExternalLink className="h-4 w-4 mr-1" />
                localhost:{port}
              </Button>
            )}
          </>
        )}
        {server?.output && server.output.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowOutput(!showOutput)}>
            {showOutput ? "Hide Output" : "Show Output"}
          </Button>
        )}
      </div>

      {/* Meta */}
      {server && (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {server.pid > 0 && (
            <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}>
              PID: {server.pid}
            </p>
          )}
          {port && (
            <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}>
              Port: {port}
            </p>
          )}
          <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}>
            {server.command}
          </p>
        </div>
      )}

      {/* Output */}
      {showOutput && server?.output && server.output.length > 0 && (
        <pre
          ref={outputRef}
          style={{
            background: "var(--bg-elevated)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border-subtle)",
            padding: "12px",
            fontSize: "0.72rem",
            fontFamily: "var(--font-mono)",
            color: "var(--text-secondary)",
            maxHeight: "256px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            margin: 0,
          }}
        >
          {server.output.join("\n")}
        </pre>
      )}
    </div>
  );
}
