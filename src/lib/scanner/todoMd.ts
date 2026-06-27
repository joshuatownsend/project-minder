import { promises as fs } from "fs";
import path from "path";
import { TodoInfo, TodoItem } from "../types";

/** Parse TODO.md-style checkbox content into a TodoInfo (undefined if no items). */
export function parseTodoMd(content: string): TodoInfo | undefined {
  const items: TodoItem[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const completedMatch = line.match(/^\s*-\s*\[x\]\s+(.*)/i);
    const pendingMatch = line.match(/^\s*-\s*\[\s\]\s+(.*)/);

    if (completedMatch) {
      items.push({ text: completedMatch[1].trim(), completed: true, lineNumber: i + 1 });
    } else if (pendingMatch) {
      items.push({ text: pendingMatch[1].trim(), completed: false, lineNumber: i + 1 });
    }
  }

  if (items.length === 0) return undefined;

  const completed = items.filter((i) => i.completed).length;
  return {
    total: items.length,
    completed,
    pending: items.length - completed,
    items,
  };
}

async function scanTodoFile(
  projectPath: string,
  filename: string
): Promise<TodoInfo | undefined> {
  try {
    const content = await fs.readFile(path.join(projectPath, filename), "utf-8");
    return parseTodoMd(content);
  } catch {
    return undefined;
  }
}

export function scanTodoMd(projectPath: string): Promise<TodoInfo | undefined> {
  return scanTodoFile(projectPath, "TODO.md");
}

/**
 * Read the companion TODO.archive.md (completed/obsolete items moved out of the
 * active list). On-demand only — the scan orchestrator never reads archive files,
 * so active dashboard counts stay clean.
 */
export function scanTodoArchive(projectPath: string): Promise<TodoInfo | undefined> {
  return scanTodoFile(projectPath, "TODO.archive.md");
}
