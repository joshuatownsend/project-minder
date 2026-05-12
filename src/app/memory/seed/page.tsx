import { Sprout } from "lucide-react";
import { MemorySeedTray } from "@/components/MemorySeedTray";

export default function MemorySeedPage() {
  return (
    <div style={{ padding: "20px 24px 40px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Sprout size={20} style={{ color: "var(--accent)" }} />
        <div>
          <h1 style={{ margin: 0, fontSize: "1.05rem", color: "var(--text-primary)" }}>
            Day 1 seed
          </h1>
          <p style={{ margin: "2px 0 0", fontSize: "0.74rem", color: "var(--text-muted)" }}>
            Candidate memory files synthesized from your existing scan data. Nothing is written until you promote each row.
          </p>
        </div>
      </header>
      <MemorySeedTray />
    </div>
  );
}
