import { FileOperation } from "@/lib/types";
import { File, Edit3, Eye, Search, Terminal } from "lucide-react";

const OP_ICONS: Record<string, typeof File> = {
  read: Eye,
  write: File,
  edit: Edit3,
  glob: Search,
  grep: Search,
  bash: Terminal,
};

const OP_COLORS: Record<string, string> = {
  read: "text-blue-400",
  write: "text-emerald-400",
  edit: "text-amber-400",
  glob: "text-violet-400",
  grep: "text-violet-400",
  bash: "text-gray-400",
};

export function SessionFileOps({ operations }: { operations: FileOperation[] }) {
  if (operations.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">
        No file operations recorded.
      </p>
    );
  }

  // Filter out bash commands that aren't real file paths
  const fileOps = operations.filter(
    (op) => op.operation !== "bash" || op.path.includes("/") || op.path.includes("\\")
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-[var(--muted-foreground)]">
            <th className="py-2 pr-4">Operation</th>
            <th className="py-2 pr-4">Path</th>
            <th className="py-2">Tool</th>
          </tr>
        </thead>
        <tbody>
          {fileOps.map((op, i) => {
            const Icon = OP_ICONS[op.operation] || File;
            const color = OP_COLORS[op.operation] || "text-gray-400";
            return (
              <tr key={i} className="border-b border-[var(--border)] hover:bg-[var(--muted)] transition-colors">
                <td className="py-1.5 pr-4">
                  <span className={`flex items-center gap-1.5 ${color}`}>
                    <Icon className="h-3 w-3" />
                    {op.operation}
                  </span>
                </td>
                <td className="py-1.5 pr-4 font-mono text-xs truncate max-w-md">
                  {op.path}
                </td>
                <td className="py-1.5 text-[var(--muted-foreground)]">
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
