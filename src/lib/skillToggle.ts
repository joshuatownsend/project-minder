import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { withFileLock } from "./atomicWrite";
import { recordPreWrite } from "./configHistory";

const SKILLS_ACTIVE_ROOT = path.resolve(path.join(os.homedir(), ".claude", "skills"));
const SKILLS_DISABLED_ROOT = path.resolve(path.join(os.homedir(), ".claude", "skills-disabled"));

export class ToggleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToggleError";
    this.code = code;
  }
}

/**
 * Move a user-scope skill between the active and disabled roots.
 *
 * `subject` is the filesystem path of the thing to move:
 *  - Bundled layout:    `~/.claude/skills[-disabled]/<slug>/` (the directory)
 *  - Standalone layout: `~/.claude/skills[-disabled]/<slug>.md` (the file)
 *
 * `enabled = true`  → move from skills-disabled → skills (re-enable)
 * `enabled = false` → move from skills → skills-disabled (disable)
 *
 * Callers compute `subject` from `SkillEntry.filePath` + `SkillEntry.layout`:
 *   bundled:    subject = path.dirname(entry.filePath)
 *   standalone: subject = entry.filePath
 */
export async function toggleUserSkill(
  subject: string,
  enabled: boolean,
): Promise<{ newPath: string }> {
  const normalizedSubject = path.resolve(subject);
  const dirName = path.basename(normalizedSubject);
  const fromRoot = enabled ? SKILLS_DISABLED_ROOT : SKILLS_ACTIVE_ROOT;
  const toRoot = enabled ? SKILLS_ACTIVE_ROOT : SKILLS_DISABLED_ROOT;

  if (path.dirname(normalizedSubject) !== fromRoot) {
    throw new ToggleError(
      "INVALID_SOURCE",
      `Skill is not in the expected directory. Expected parent: ${fromRoot}`,
    );
  }

  const newPath = path.join(toRoot, dirName);

  return withFileLock(normalizedSubject, async () => {
    // Ensure the subject still exists (guard against concurrent delete)
    try {
      await fs.access(normalizedSubject);
    } catch {
      throw new ToggleError("NOT_FOUND", `Skill not found at ${normalizedSubject}`);
    }

    // Ensure the destination doesn't already exist (avoid clobbering)
    try {
      await fs.access(newPath);
      throw new ToggleError(
        "DEST_EXISTS",
        `A skill named "${dirName}" already exists in the target directory (${toRoot}).`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException & { code?: string }).code !== "ENOENT") throw e;
    }

    // Best-effort snapshot before moving (non-fatal)
    const snapshotTarget = (await isDirectory(normalizedSubject))
      ? path.join(normalizedSubject, "SKILL.md")
      : normalizedSubject;
    await recordPreWrite(snapshotTarget, { label: "skillToggle" }).catch(() => {});

    await fs.mkdir(toRoot, { recursive: true });
    await fs.rename(normalizedSubject, newPath);

    return { newPath };
  });
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Compute the subject (thing to move) from a SkillEntry's filePath and layout. */
export function skillSubjectPath(filePath: string, layout: "bundled" | "standalone"): string {
  return layout === "bundled" ? path.dirname(filePath) : filePath;
}
