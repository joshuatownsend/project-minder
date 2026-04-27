import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "./parseFrontmatter";
import { resolveProvenance } from "./provenance";
import type { SkillEntry, CatalogSource, ProvenanceContext } from "./types";

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
    isSymlink?: boolean;
    realPath?: string;
    ctx: ProvenanceContext;
  }
): SkillEntry {
  const { fm, body } = parseFrontmatter(text);

  const slug =
    layout === "bundled"
      ? path.basename(path.dirname(filePath))
      : path.basename(filePath, ".md");

  const rawName = fm.name;
  const name = typeof rawName === "string" && rawName ? rawName : slug;

  const prefix = opts.pluginName ?? opts.projectSlug ?? "user";
  const id =
    layout === "bundled"
      ? `skill:${source}:${prefix}:bundled:${slug}`
      : `skill:${source}:${prefix}:${slug}`;

  const userInvocable =
    fm["user-invocable"] === true ||
    fm["user-invocable"] === "true" ||
    fm.userInvocable === true;

  const provenance = resolveProvenance({
    source,
    entryKind: "skill",
    slug,
    isSymlink: opts.isSymlink,
    realPath: opts.realPath,
    pluginName: opts.pluginName,
    projectSlug: opts.projectSlug,
    ctx: opts.ctx,
  });

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
    argumentHint:
      typeof fm["argument-hint"] === "string" ? fm["argument-hint"] : undefined,
    provenance,
    isSymlink: opts.isSymlink,
    realPath: opts.realPath,
  };
}

async function walkSkillsRoot(
  root: string,
  source: CatalogSource,
  opts: { pluginName?: string; projectSlug?: string; ctx: ProvenanceContext }
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

      if (entry.isDirectory()) {
        // Regular (non-symlink) directory — check for bundled SKILL.md
        const skillMdPath = path.join(fullPath, "SKILL.md");
        try {
          const [text, stat] = await Promise.all([
            fs.readFile(skillMdPath, "utf-8"),
            fs.stat(skillMdPath),
          ]);
          results.push(
            makeSkillEntry(skillMdPath, text, source, "bundled", {
              ...opts,
              mtime: stat.mtime,
              ctime: stat.ctime,
            })
          );
        } catch {
          // No SKILL.md — skip
        }
      } else if (entry.isSymbolicLink()) {
        // Symlink — resolve and check if it points to a directory with SKILL.md
        let realDir: string | undefined;
        try {
          realDir = await fs.realpath(fullPath);
          const st = await fs.stat(realDir);
          if (!st.isDirectory()) return;
        } catch {
          return;
        }
        const skillMdPath = path.join(fullPath, "SKILL.md");
        try {
          const [text, stat] = await Promise.all([
            fs.readFile(skillMdPath, "utf-8"),
            fs.stat(skillMdPath),
          ]);
          const realPath = path.join(realDir, "SKILL.md");
          results.push(
            makeSkillEntry(skillMdPath, text, source, "bundled", {
              ...opts,
              mtime: stat.mtime,
              ctime: stat.ctime,
              isSymlink: true,
              realPath,
            })
          );
        } catch {
          // No SKILL.md — skip
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
          results.push(
            makeSkillEntry(fullPath, text, source, "standalone", {
              ...opts,
              mtime: stat.mtime,
              ctime: stat.ctime,
            })
          );
        } catch {
          // skip
        }
      }
    })
  );

  return results;
}

export async function walkUserSkills(ctx: ProvenanceContext): Promise<SkillEntry[]> {
  const root = path.join(os.homedir(), ".claude", "skills");
  return walkSkillsRoot(root, "user", { ctx });
}

export async function walkPluginSkills(ctx: ProvenanceContext): Promise<SkillEntry[]> {
  const all: SkillEntry[] = [];

  await Promise.all(
    ctx.installedPlugins.map(async ({ pluginName, installPath }) => {
      const skillsDir = path.join(installPath, "skills");
      try {
        await fs.access(skillsDir);
      } catch {
        return;
      }
      const entries = await walkSkillsRoot(skillsDir, "plugin", { pluginName, ctx });
      all.push(...entries);
    })
  );

  return all;
}

export async function walkProjectSkills(
  projectPath: string,
  projectSlug: string,
  ctx: ProvenanceContext
): Promise<SkillEntry[]> {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  try {
    await fs.access(skillsDir);
  } catch {
    return [];
  }
  return walkSkillsRoot(skillsDir, "project", { projectSlug, ctx });
}
