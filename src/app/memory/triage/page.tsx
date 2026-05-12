import { Trash2 } from "lucide-react";
import { MemoryTriage } from "@/components/MemoryTriage";

export default function MemoryTriagePage() {
  return (
    <div style={{ padding: "20px 24px 40px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Trash2 size={20} style={{ color: "var(--accent)" }} />
        <div>
          <h1 style={{ margin: 0, fontSize: "1.05rem", color: "var(--text-primary)" }}>
            Memory triage
          </h1>
          <p style={{ margin: "2px 0 0", fontSize: "0.74rem", color: "var(--text-muted)" }}>
            Stale memory recommendations. Archive moves a file aside (reversible); Delete soft-deletes for 30 days; Keep silences the row for a fixed window.
          </p>
        </div>
      </header>
      <MemoryTriage />
    </div>
  );
}
