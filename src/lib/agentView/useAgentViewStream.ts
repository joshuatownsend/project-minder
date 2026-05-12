"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { LiveAgentSession, ConnectionState } from "./types";

// React hook that owns the EventSource connection to /api/agent-view/stream.
//
// Reconnect backoff: 1 s → 5 s → 15 s, capped at 15 s.
// After 2 consecutive SSE failures, falls back to polling /api/agent-view
// every 5 s. Polling continues until SSE succeeds again.
//
// Returns sessions sorted by the server (waiting → working → idle → ...).

const STREAM_URL = "/api/agent-view/stream";
const SNAPSHOT_URL = "/api/agent-view";
const BACKOFF_STEPS = [1000, 5000, 15000];
const FALLBACK_POLL_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 2;

export interface AgentViewStreamResult {
  sessions: LiveAgentSession[];
  connectionState: ConnectionState;
  lastEventAt: number | null;
}

export function useAgentViewStream(): AgentViewStreamResult {
  const [sessions, setSessions] = useState<LiveAgentSession[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const failCount = useRef(0);
  const backoffRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch(SNAPSHOT_URL);
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: LiveAgentSession[] };
      if (Array.isArray(data.sessions)) {
        setSessions(data.sessions);
        setLastEventAt(Date.now());
      }
    } catch {
      // silently ignore polling failure
    }
  }, []);

  const startFallbackPolling = useCallback(() => {
    setConnectionState("fallback");
    fetchSnapshot();
    const tick = () => {
      fetchSnapshot();
      pollTimerRef.current = setTimeout(tick, FALLBACK_POLL_MS);
    };
    pollTimerRef.current = setTimeout(tick, FALLBACK_POLL_MS);
  }, [fetchSnapshot]);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    clearPoll();
    setConnectionState("connecting");

    const es = new EventSource(STREAM_URL);
    esRef.current = es;

    es.addEventListener("snapshot", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { sessions: LiveAgentSession[] };
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions);
          setLastEventAt(Date.now());
          setConnectionState("connected");
          failCount.current = 0;
          backoffRef.current = 0;
        }
      } catch {
        // malformed event — ignore
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      failCount.current++;
      setConnectionState("reconnecting");

      if (failCount.current >= MAX_CONSECUTIVE_FAILURES) {
        startFallbackPolling();
        return;
      }

      const delay = BACKOFF_STEPS[Math.min(backoffRef.current, BACKOFF_STEPS.length - 1)];
      backoffRef.current++;
      setTimeout(connect, delay);
    };
  }, [clearPoll, startFallbackPolling]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
      clearPoll();
    };
  }, [connect, clearPoll]);

  return { sessions, connectionState, lastEventAt };
}
