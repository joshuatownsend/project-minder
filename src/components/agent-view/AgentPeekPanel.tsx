"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LiveAgentSession } from "@/lib/agentView/types";
import type { HookEvent } from "@/lib/hooks/buffer";

interface PeekData {
  hookEvents: HookEvent[];
}

function formatEventTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface AgentPeekPanelProps {
  session: LiveAgentSession | null;
  onClose: () => void;
}

export function AgentPeekPanel({ session, onClose }: AgentPeekPanelProps) {
  const [data, setData] = useState<PeekData | null>(null);

  useEffect(() => {
    if (!session) { setData(null); return; }
    let aborted = false;
    fetch(`/api/agent-view/peek?slug=${encodeURIComponent(session.projectSlug)}`)
      .then((r) => r.json())
      .then((d) => { if (!aborted) setData(d as PeekData); })
      .catch(() => { /* peek is best-effort */ });
    return () => { aborted = true; };
  }, [session?.sessionId, session?.projectSlug]);

  if (!session) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 40,
          background: "rgba(0,0,0,0.5)",
        }}
      />
      {/* Drawer */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 50,
        width: Math.min(480, window.innerWidth - 32),
        background: "var(--card-bg,#111)",
        borderLeft: "1px solid var(--line-soft,#222)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--line-soft,#222)",
        }}>
          <span style={{ fontWeight: 600, fontSize: "0.85rem", flex: 1 }}>
            {session.projectName}
          </span>
          <Link
            href={`/sessions/${session.sessionId}`}
            style={{ fontSize: "0.65rem", color: "var(--text-3,#888)", textDecoration: "none" }}
          >
            Full session →
          </Link>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-3,#888)", cursor: "pointer", fontSize: "1rem", padding: "0 4px" }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
          {/* Session meta */}
          <div style={{ marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Chip label="Status" value={session.status} />
            {session.currentToolName && <Chip label="Last tool" value={session.currentToolName} />}
            {session.model && <Chip label="Model" value={session.model} />}
            <Chip label="Source" value={session.livenessSource} />
          </div>

          {/* Hook events */}
          <section>
            <SectionLabel>
              Hook events
              <span style={{ color: "var(--text-4,#555)", fontWeight: 400, marginLeft: 6 }}>
                (last 5 min)
              </span>
            </SectionLabel>
            {!data ? (
              <div style={{ fontSize: "0.7rem", color: "var(--text-4,#555)" }}>Loading…</div>
            ) : data.hookEvents.length === 0 ? (
              <div style={{ fontSize: "0.7rem", color: "var(--text-4,#555)" }}>
                No hook events. Enable Live Activity in Settings to see them.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {[...data.hookEvents].reverse().slice(0, 30).map((ev, i) => (
                  <div key={i} style={{
                    display: "flex", gap: 8, alignItems: "baseline",
                    fontSize: "0.65rem", fontFamily: "var(--font-mono,monospace)",
                  }}>
                    <span style={{ color: "var(--text-4,#555)", flexShrink: 0 }}>
                      {formatEventTime(ev.receivedAt)}
                    </span>
                    <span style={{ color: "var(--amber-text,#fbbf24)", flexShrink: 0 }}>
                      {ev.hookEventName}
                    </span>
                    {ev.toolName && (
                      <span style={{ color: "var(--text-2,#ccc)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ev.toolName}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: "inline-flex", gap: 4, alignItems: "center",
      background: "var(--card-bg-2,#1a1a1a)",
      border: "1px solid var(--line-soft,#222)",
      borderRadius: 4, padding: "2px 7px", fontSize: "0.6rem",
    }}>
      <span style={{ color: "var(--text-4,#555)" }}>{label}</span>
      <span style={{ color: "var(--text-1,#fff)", fontFamily: "var(--font-mono,monospace)" }}>{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.08em",
      textTransform: "uppercase", color: "var(--text-3,#888)",
      marginBottom: 6, marginTop: 12,
    }}>
      {children}
    </div>
  );
}
