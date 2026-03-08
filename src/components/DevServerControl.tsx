"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Play, Square, RotateCw, Terminal, ExternalLink } from "lucide-react";

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

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/dev-server/${slug}`);
      const data = await res.json();
      if (data.pid) {
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
        body: JSON.stringify({ action, projectPath }),
      });
      const data = await res.json();
      if (data.pid) {
        setServer(data);
        if (action === "start" || action === "restart") {
          setShowOutput(true);
        }
      } else {
        setServer(null);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const isActive =
    server?.status === "running" || server?.status === "starting";
  const port = server?.port || devPort;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {isActive ? (
          <>
            <Badge className={statusStyles[server!.status]}>
              {server!.status === "starting" ? "Starting..." : `Running :${port || "?"}`}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                doAction("stop");
              }}
              disabled={loading}
              title="Stop server"
            >
              <Square className="h-3 w-3" />
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              doAction("start");
            }}
            disabled={loading}
            title="Start dev server"
          >
            <Play className="h-3 w-3 mr-1" />
            Start
          </Button>
        )}
      </div>
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
