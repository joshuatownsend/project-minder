"use client";

import { AgentViewBoard } from "@/components/agent-view/AgentViewBoard";

export default function AgentViewPage() {
  return (
    <main style={{ padding: "16px 20px", height: "calc(100vh - 52px)", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: 8 }}>
        <h1 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>Agent View</h1>
        <p style={{ fontSize: "0.7rem", color: "var(--text-4,#555)", margin: "2px 0 0" }}>
          Live Kanban of running Claude Code sessions
        </p>
      </div>
      <AgentViewBoard />
    </main>
  );
}
