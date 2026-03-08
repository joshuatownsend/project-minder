import { promises as fs } from "fs";
import path from "path";
import { TodoInfo, TodoItem } from "../types";

export async function scanTodoMd(
  projectPath: string
): Promise<TodoInfo | undefined> {
  try {
    const content = await fs.readFile(
      path.join(projectPath, "TODO.md"),
      "utf-8"
    );

    const items: TodoItem[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const completedMatch = line.match(/^\s*-\s*\[x\]\s+(.*)/i);
      const pendingMatch = line.match(/^\s*-\s*\[\s\]\s+(.*)/);

      if (completedMatch) {
        items.push({ text: completedMatch[1].trim(), completed: true });
      } else if (pendingMatch) {
        items.push({ text: pendingMatch[1].trim(), completed: false });
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
  } catch {
    return undefined;
  }
}
