import { BoardInfo } from "@/lib/types";
import { LayoutDashboard } from "lucide-react";

/**
 * Compact card badge: count of open (non-done) board issues. Mirrors the
 * inline-style convention of the other card compacts (CSS vars, not Tailwind).
 * Renders nothing when the board is empty.
 */
export function BoardCompact({ board }: { board: BoardInfo }) {
  if (board.total === 0) return null;
  const open = board.epics
    .flatMap((e) => e.issues)
    .concat(board.inbox)
    .filter((i) => i.status !== "done").length;
  if (open === 0) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <LayoutDashboard
        style={{ width: "11px", height: "11px", color: "var(--text-muted)" }}
      />
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
        {open} open
      </span>
    </div>
  );
}
