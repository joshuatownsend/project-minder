import "server-only";
import path from "path";
import { createTask } from "./store";
import { toggleTodoInFile } from "../todoWriter";
import { readConfig, getDevRoots } from "../config";
import type { Task } from "./types";

export interface DelegateTodoInput {
  projectSlug: string;
  lineNumber: number;
  todoText: string;
  /** Dev roots to search for the project path; defaults to config devRoots. */
  devRoots?: string[];
}

export interface DelegateTodoResult {
  taskId: number;
}

/** Resolve a project slug back to its filesystem path via devRoots. */
async function resolveProjectPath(slug: string, devRoots: string[]): Promise<string | null> {
  // Project directories use the filesystem name directly (no encoding).
  // Slug is the directory basename with special chars replaced, but for
  // local delegation we can try the most common case: basename === slug.
  for (const root of devRoots) {
    const candidate = path.join(root, slug);
    try {
      const { promises: fs } = await import("fs");
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Not found in this root — try next
    }
  }
  return null;
}

/**
 * Create a task in the dispatcher queue for a TODO item.
 * The task's metadata encodes the source file and line number so
 * `onTaskCompleteToggleTodo` can check off the item when the task finishes.
 */
export async function delegateTodo(input: DelegateTodoInput): Promise<DelegateTodoResult> {
  const cfg = await readConfig();
  const devRoots = input.devRoots ?? getDevRoots(cfg);

  const projectPath = await resolveProjectPath(input.projectSlug, devRoots);
  if (!projectPath) {
    throw new Error(`Project "${input.projectSlug}" not found in devRoots: ${devRoots.join(", ")}`);
  }

  const task = await createTask({
    title: input.todoText.slice(0, 120),
    description: input.todoText,
    quadrant: "delegated-todo",
    metadata: {
      sourceFile: "TODO.md",
      lineNumber: input.lineNumber,
      projectSlug: input.projectSlug,
      projectPath,
    },
  });

  return { taskId: task.id };
}

interface TodoMeta {
  sourceFile: string;
  lineNumber: number;
  projectPath: string;
  projectSlug: string;
}

function parseTodoMeta(task: Task): TodoMeta | null {
  if (!task.metadata) return null;
  try {
    const m = JSON.parse(task.metadata) as TodoMeta;
    if (m.sourceFile === "TODO.md" && typeof m.lineNumber === "number" && m.projectPath) {
      return m;
    }
  } catch {
    // malformed metadata — ignore
  }
  return null;
}

/**
 * Called when a task completes or fails. If the task was created via
 * todoDelegation, check off the corresponding TODO.md item.
 * Best-effort — failure logs a warning and does not fail the task.
 */
export async function onTaskCompleteToggleTodo(task: Task): Promise<void> {
  const meta = parseTodoMeta(task);
  if (!meta || task.status !== "done") return;

  try {
    await toggleTodoInFile(meta.projectPath, meta.lineNumber);
  } catch (err) {
    console.warn(
      `[todoDelegation] Failed to toggle TODO item for task ${task.id} ` +
        `(${meta.projectPath}/TODO.md line ${meta.lineNumber}):`,
      err
    );
  }
}
