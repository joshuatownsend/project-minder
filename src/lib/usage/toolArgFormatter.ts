export type ToolArgKind = "command" | "file-path" | "edit-diff" | "json";

export interface FormattedToolArg {
  kind: ToolArgKind;
  /** Short label for collapsed view (≤80 chars). */
  preview: string;
  /** Full content for expanded view. */
  content: string;
}

const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_PATH_TOOLS = new Set(["Read", "Write", "Glob"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit"]);

export function formatToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined | null
): FormattedToolArg {
  if (!args) {
    return { kind: "json", preview: "(no args)", content: "" };
  }

  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = typeof args.command === "string" ? args.command : JSON.stringify(args);
    return {
      kind: "command",
      preview: cmd.length > 80 ? cmd.slice(0, 79) + "…" : cmd,
      content: cmd,
    };
  }

  if (FILE_PATH_TOOLS.has(toolName)) {
    const filePath = typeof args.file_path === "string" ? args.file_path
      : typeof args.pattern === "string" ? args.pattern
      : "";
    return {
      kind: "file-path",
      preview: filePath.length > 80 ? "…" + filePath.slice(-79) : filePath || "(no path)",
      content: filePath || "(no path)",
    };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const oldStr = typeof args.old_string === "string" ? args.old_string : "";
    const newStr = typeof args.new_string === "string" ? args.new_string : "";
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    const isTruncated = typeof args.old_string === "string" && args.old_string.endsWith("…");

    const lines: string[] = [];
    if (filePath) lines.push(`--- ${filePath}`, `+++ ${filePath}`);
    for (const line of oldStr.split("\n")) {
      lines.push(`- ${line}`);
    }
    for (const line of newStr.split("\n")) {
      lines.push(`+ ${line}`);
    }
    if (isTruncated) lines.push("(truncated — arguments_json 32 KB cap)");

    const preview = filePath
      ? filePath.length > 70
        ? "…" + filePath.slice(-69)
        : filePath
      : oldStr.slice(0, 40).replace(/\n/g, "↵") + (oldStr.length > 40 ? "…" : "");

    return { kind: "edit-diff", preview, content: lines.join("\n") };
  }

  const json = JSON.stringify(args, null, 2);
  const firstLine = JSON.stringify(args).slice(0, 80);
  return {
    kind: "json",
    preview: firstLine.length === 80 ? firstLine.slice(0, 77) + "…" : firstLine,
    content: json,
  };
}
