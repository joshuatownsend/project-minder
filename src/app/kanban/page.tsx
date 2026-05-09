"use client";

import { KanbanBoard } from "@/components/KanbanBoard";
import { HelpButton } from "@/components/HelpButton";

export default function KanbanPage() {
  return (
    <main style={{ padding: "24px", maxWidth: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "20px",
        }}
      >
        <h1
          style={{
            fontSize: "1.1rem",
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "var(--text-primary)",
            margin: 0,
          }}
        >
          Mission Control — Kanban
        </h1>
        <HelpButton />
      </div>
      <KanbanBoard />
    </main>
  );
}
