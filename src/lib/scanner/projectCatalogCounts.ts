import { promises as fs } from "fs";
import path from "path";

/**
 * Count project-local agents and skills without parsing frontmatter.
 * Fast: only readdir, no file reads.
 */
export async function countProjectCatalog(
  projectPath: string
): Promise<{ agentCount: number; skillCount: number }> {
  const [agentCount, skillCount] = await Promise.all([
    countAgents(projectPath),
    countSkills(projectPath),
  ]);
  return { agentCount, skillCount };
}

async function countAgents(projectPath: string): Promise<number> {
  return countAgentsDir(path.join(projectPath, ".claude", "agents"));
}

async function countAgentsDir(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith(".")) return;
      if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md") && !e.name.endsWith(".tmpl")) {
        count++;
      } else if (e.isDirectory()) {
        count += await countAgentsDir(path.join(dir, e.name));
      }
    })
  );
  return count;
}

async function countSkills(projectPath: string): Promise<number> {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".tmpl")) {
        // Standalone layout
        count++;
      } else if (e.isDirectory() || e.isSymbolicLink()) {
        // Bundled layout — check for SKILL.md
        try {
          await fs.access(path.join(skillsDir, e.name, "SKILL.md"));
          count++;
        } catch {
          // no SKILL.md — skip
        }
      }
    }
    return count;
  } catch {
    return 0;
  }
}
