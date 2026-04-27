import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "./parseFrontmatter";
import { loadInstalledPlugins } from "./walkPlugins";
import type { SkillEntry, CatalogSource } from "./types";

function makeSkillEntry(
  filePath: string,
  text: string,
  source: CatalogSource,
  layout: "bundled" | "standalone",
  opts: {
    pluginName?: string;
    projectSlug?: string;
    category?: string;
    mtime: Date;
    ctime: Date;
  }
): SkillEntry {
  const { fm, body } = parseFrontmatter(text);

  // For bundled skills, slug is the directory name; for standalone, the file basename
  const slug =
    layout === "bundled"
      ? path.basename(path.dirname(filePath))
      : path.basename(filePath, ".md");

  const rawName = fm.name;
  const name = typeof rawName === "string" && rawName ? rawName : slug;

  const prefix = opts.pluginName ?? opts.projectSlug ?? "user";
  const id = `${source}:${prefix}:${slug}`;

  const userInvocable =
    fm["user-invocable"] === true ||
    fm["user-invocable"] === "true" ||
    fm.userInvocable === true;

  return {
    id,
    kind: "skill",
    slug,
    name,
    description: typeof fm.description === "string" ? fm.description : undefined,
    source,
    pluginName: opts.pluginName,
    projectSlug: opts.projectSlug,
    category: opts.category,
    filePath,
    bodyExcerpt: body.slice(0, 400),
    frontmatter: fm,
    mtime: opts.mtime.toISOString(),
    ctime: opts.ctime.toISOString(),
    layout,
    version: typeof fm.version === "string" ? fm.version : undefined,
    userInvocable,
    argumentHint: typeof fm["argument-hint"] === "string" ? fm["argument-hint"] : undefined,
  };
}

async function walkSkillsRoot(
  root: string,
  source: CatalogSource,
  opts: { pluginName?: string; projectSlug?: string }
): Promise<SkillEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: SkillEntry[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;

      const fullPath = path.join(root, entry.name);

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        // Check for SKILL.md inside — bundled layout
        const skillMdPath = path.join(fullPath, "SKILL.md");
        try {
          const [text, stat] = await Promise.all([
            fs.readFile(skillMdPath, "utf-8"),
            fs.stat(skillMdPath),
          ]);
          const skill = makeSkillEntry(skillMdPath, text, source, "bundled", {
            ...opts,
            mtime: stat.mtime,
            ctime: stat.ctime,
          });
          results.push(skill);
        } catch {
          // No SKILL.md — skip this directory
        }
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        !entry.name.endsWith(".tmpl")
      ) {
        // Standalone layout — top-level .md in a skills root
        try {
          const [text, stat] = await Promise.all([
            fs.readFile(fullPath, "utf-8"),
            fs.stat(fullPath),
          ]);
          const skill = makeSkillEntry(fullPath, text, source, "standalone", {
            ...opts,
            mtime: stat.mtime,
            ctime: stat.ctime,
          });
          results.push(skill);
        } catch {
          // skip
        }
      }
    })
  );

  return results;
}

export async function walkUserSkills(): Promise<SkillEntry[]> {
  const root = path.join(os.homedir(), ".claude", "skills");
  return walkSkillsRoot(root, "user", {});
}

export async function walkPluginSkills(): Promise<SkillEntry[]> {
  const plugins = await loadInstalledPlugins();
  const all: SkillEntry[] = [];

  await Promise.all(
    plugins.map(async ({ pluginName, installPath }) => {
      const skillsDir = path.join(installPath, "skills");
      try {
        await fs.access(skillsDir);
      } catch {
        return;
      }
      const entries = await walkSkillsRoot(skillsDir, "plugin", { pluginName });
      all.push(...entries);
    })
  );

  return all;
}

export async function walkProjectSkills(
  projectPath: string,
  projectSlug: string
): Promise<SkillEntry[]> {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  try {
    await fs.access(skillsDir);
  } catch {
    return [];
  }
  return walkSkillsRoot(skillsDir, "project", { projectSlug });
}
