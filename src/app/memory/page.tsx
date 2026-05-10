import { Brain } from "lucide-react";
import { MemoryBrowser } from "@/components/MemoryBrowser";

export default function MemoryPage() {
  return (
    <div style={{ padding: "20px 24px 40px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Brain size={20} style={{ color: "var(--accent)" }} />
        <div>
          <h1 style={{ margin: 0, fontSize: "1.05rem", color: "var(--text-primary)" }}>Memory</h1>
          <p style={{ margin: "2px 0 0", fontSize: "0.74rem", color: "var(--text-muted)" }}>
            Cross-tier inventory of every CLAUDE.md and auto-memory file Claude reads.
          </p>
        </div>
      </header>
      <MemoryBrowser />
    </div>
  );
}
