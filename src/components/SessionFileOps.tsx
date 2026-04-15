import { FileOperation } from "@/lib/types";
import { File, Edit3, Eye, Search, Terminal } from "lucide-react";

const OP_ICONS: Record<string, typeof File> = {
  read: Eye, write: File, edit: Edit3, glob: Search, grep: Search, bash: Terminal,
};

const OP_COLORS: Record<string, string> = {
  read:  "var(--text-secondary)",
  write: "var(--status-active-text)",
  edit:  "var(--accent)",
  glob:  "var(--text-muted)",
  grep:  "var(--text-muted)",
  bash:  "var(--text-muted)",
};

export function SessionFileOps({ operations }: { operations: FileOperation[] }) {
  if (operations.length === 0) {
    return <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>No file operations recorded.</p>;
  }

  const fileOps = operations.filter(
    (op) => op.operation !== "bash" || op.path.includes("/") || op.path.includes("\\")
  );

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
            {["Op", "Path", "Tool"].map((h) => (
              <th key={h} style={{ padding: "6px 12px 6px 0", textAlign: "left", fontSize: "0.62rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)", fontFamily: "var(--font-body)", whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fileOps.map((op, i) => {
            const Icon = OP_ICONS[op.operation] || File;
            const color = OP_COLORS[op.operation] || "var(--text-muted)";
            return (
              <tr
                key={i}
                style={{ borderBottom: "1px solid var(--border-subtle)" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--bg-elevated)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
              >
                <td style={{ padding: "6px 12px 6px 0", whiteSpace: "nowrap" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "5px", color, fontSize: "0.72rem", fontFamily: "var(--font-body)" }}>
                    <Icon style={{ width: "11px", height: "11px" }} />
                    {op.operation}
                  </span>
                </td>
                <td style={{ padding: "6px 12px 6px 0", fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-primary)", maxWidth: "480px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {op.path}
                </td>
                <td style={{ padding: "6px 0", fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {op.toolName}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
