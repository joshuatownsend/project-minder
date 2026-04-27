"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
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

const statusStyles: Record<string, string> = {
  starting:
    "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 border-blue-200 dark:border-blue-800",
  running:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800",
  stopped:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700",
  errored:
    "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 border-red-200 dark:border-red-800",
};

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
    const isActive =
      server?.status === "running" || server?.status === "starting";
    if (isActive) {
      pollRef.current = setInterval(fetchStatus, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
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
            title="Stop server"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "22px", height: "22px",
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
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Dev Server
        </h3>
        {server && (
          <Badge className={statusStyles[server.status]}>{server.status}</Badge>
        )}
        {!server && (
          <Badge className={statusStyles.stopped}>stopped</Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        {!isActive ? (
          <Button
            variant="default"
            size="sm"
            onClick={() => doAction("start")}
            disabled={loading}
          >
            <Play className="h-4 w-4 mr-1" />
            {loading ? "Starting..." : "Start"}
          </Button>
        ) : (
          <>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => doAction("stop")}
              disabled={loading}
            >
              <Square className="h-4 w-4 mr-1" />
              Stop
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => doAction("restart")}
              disabled={loading}
            >
              <RotateCw className="h-4 w-4 mr-1" />
              Restart
            </Button>
            {port && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  window.open(`http://localhost:${port}`, "_blank")
                }
              >
                <ExternalLink className="h-4 w-4 mr-1" />
                localhost:{port}
              </Button>
            )}
          </>
        )}
        {server?.output && server.output.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowOutput(!showOutput)}
          >
            {showOutput ? "Hide Output" : "Show Output"}
          </Button>
        )}
      </div>

      {server && (
        <div className="text-xs text-[var(--muted-foreground)] space-y-1">
          {server.pid > 0 && <p>PID: {server.pid}</p>}
          {port && <p>Port: {port}</p>}
          <p>Command: {server.command}</p>
        </div>
      )}

      {showOutput && server?.output && server.output.length > 0 && (
        <pre
          ref={outputRef}
          className="bg-[var(--secondary)] rounded-md p-3 text-xs font-mono max-h-64 overflow-auto whitespace-pre-wrap"
        >
          {server.output.join("\n")}
        </pre>
      )}
    </div>
  );
}
