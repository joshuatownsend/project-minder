import { promises as fs } from "fs";
import path from "path";
import { scanTodoMd } from "./scanner/todoMd";
import { TodoInfo } from "./types";
import { writeFileAtomic, withFileLock } from "./atomicWrite";

const MAX_TODO_LENGTH = 500;

export class TodoWriteError extends Error {
  constructor(message: string, public code: "EMPTY" | "TOO_LONG") {
    super(message);
    this.name = "TodoWriteError";
  }
}

function sanitize(text: string): string {
  // Collapse any newlines/tabs to single spaces so one line = one item.
  const cleaned = text.replace(/[\r\n\t]+/g, " ").trim();
  if (cleaned.length === 0) {
    throw new TodoWriteError("TODO text is empty", "EMPTY");
  }
  if (cleaned.length > MAX_TODO_LENGTH) {
    throw new TodoWriteError(
      `TODO text exceeds ${MAX_TODO_LENGTH} characters`,
      "TOO_LONG"
    );
  }
  return cleaned;
}

/**
 * Append one or more TODO items to a project's TODO.md.
 * Creates the file with a default header if it does not exist.
 * Returns the refreshed TodoInfo after the write.
 */
export async function appendTodosToFile(
  projectPath: string,
  texts: string[]
): Promise<TodoInfo> {
  const sanitized = texts.map(sanitize);
  const filePath = path.join(projectPath, "TODO.md");

  return withFileLock(filePath, async () => {
    let existing: string;
    try {
      existing = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        existing = "# TODO\n\n";
      } else {
        throw err;
      }
    }

    // Normalize trailing whitespace before appending.
    // Preserve the conventional blank line after a standalone "# TODO" header
    // so newly-seeded files read as "# TODO\n\n- [ ] ...".
    const normalized = existing.replace(/[\r\n]*$/, "");
    const base =
      normalized.length === 0
        ? ""
        : normalized === "# TODO"
          ? normalized + "\n\n"
          : normalized + "\n";
    const appended =
      base + sanitized.map((t) => `- [ ] ${t}`).join("\n") + "\n";

    await writeFileAtomic(filePath, appended);

    const info = await scanTodoMd(projectPath);
    // scanTodoMd returns undefined only if zero items — after an append this
    // should never happen, but fall back to a safe empty shape just in case.
    return (
      info ?? {
        total: sanitized.length,
        completed: 0,
        pending: sanitized.length,
        items: sanitized.map((t) => ({ text: t, completed: false })),
      }
    );
  });
}

export async function toggleTodoInFile(
  projectPath: string,
  lineNumber: number
): Promise<TodoInfo> {
  const filePath = path.join(projectPath, "TODO.md");
  return withFileLock(filePath, async () => {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const idx = lineNumber - 1;

    let changed = false;

    if (idx >= 0 && idx < lines.length) {
      const line = lines[idx];
      if (line.match(/^\s*-\s*\[\s\]/)) {
        lines[idx] = line.replace(/^(\s*-\s*)\[\s\]/, "$1[x]");
        changed = true;
      } else if (line.match(/^\s*-\s*\[x\]/i)) {
        lines[idx] = line.replace(/^(\s*-\s*)\[x\]/i, "$1[ ]");
        changed = true;
      }
    }

    if (changed) {
      await writeFileAtomic(filePath, lines.join("\n"));
    }
    const info = await scanTodoMd(projectPath);
    return info ?? { total: 0, completed: 0, pending: 0, items: [] };
  });
}
