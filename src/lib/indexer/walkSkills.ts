import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter, coerceFrontmatterBoolean } from "./parseFrontmatter";
import { resolveProvenance } from "./provenance";
import { resolvePluginSkillsRoots } from "./walkPlugins";
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
    disabled?: boolean;
  }
): SkillEntry {
  const { fm, body, warnings } = parseFrontmatter(text);

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

  // Defaults to TRUE, matching Claude Code: "By default, both users and Claude
  // can invoke any skill", and `user-invocable: false` is what *hides* a skill
  // from the `/` menu.
  //
  // Minder defaulted this to `false` and so inverted the documented behaviour
  // (Codex review of #384, confirmed against the skills reference). It was not
  // a cosmetic slip: `selectSkillChips` filters on `userInvocable === true`, so
  // every skill that simply did not mention the key — the overwhelming majority
  // — was withheld from the workflow-launcher chips, and the catalog reported
  // it as not user-invocable when Claude Code would happily run it as a slash
  // command.
  //
  // `coerceFrontmatterBoolean` honours the `yes`/`on`/`1` spellings Claude Code
  // accepts. The camelCase alias stays supported.
  const userInvocable =
    coerceFrontmatterBoolean(fm["user-invocable"]) ??
    coerceFrontmatterBoolean(fm.userInvocable) ??
    true;

  // 2.1.218 frontmatter. `disable-model-invocation` is the one that changes how
  // a skill can be reached — it stays available as a slash command but Claude
  // can no longer choose it — so the catalog surfaces it rather than leaving it
  // buried in the raw frontmatter blob.
  const disableModelInvocation = coerceFrontmatterBoolean(
    fm["disable-model-invocation"]
  );
  const background = coerceFrontmatterBoolean(fm.background);

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
    disableModelInvocation,
    background,
    context: typeof fm.context === "string" ? fm.context : undefined,
    effort: typeof fm.effort === "string" ? fm.effort : undefined,
    model: typeof fm.model === "string" ? fm.model : undefined,
    argumentHint:
      typeof fm["argument-hint"] === "string" ? fm["argument-hint"] : undefined,
    provenance,
    isSymlink: opts.isSymlink,
    realPath: opts.realPath,
    parseWarnings: warnings.length > 0 ? warnings : undefined,
    disabled: opts.disabled || undefined,
    fileBytes: Buffer.byteLength(text, "utf-8"),
  };
}

async function walkSkillsRoot(
  root: string,
  source: CatalogSource,
  opts: { pluginName?: string; projectSlug?: string; ctx: ProvenanceContext; disabled?: boolean }
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
        // Regular (non-symlink) directory — check for bundled SKILL.md.
        //
        // Only the READ is inside the try. `makeSkillEntry` used to sit in here
        // too, so anything it threw — a malformed ProvenanceContext, say — was
        // indistinguishable from "this directory has no SKILL.md", and the
        // walker returned a plausible, silently-short catalog instead of
        // failing. An empty skills list that looks like a legitimate answer is
        // much harder to notice than an error.
        const skillMdPath = path.join(fullPath, "SKILL.md");
        let read: [string, Awaited<ReturnType<typeof fs.stat>>] | undefined;
        try {
          read = await Promise.all([
            fs.readFile(skillMdPath, "utf-8"),
            fs.stat(skillMdPath),
          ]);
        } catch {
          // No SKILL.md — skip
        }
        if (read) {
          const [text, stat] = read;
          results.push(
            makeSkillEntry(skillMdPath, text, source, "bundled", {
              ...opts,
              mtime: stat.mtime,
              ctime: stat.ctime,
            })
          );
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
  const activeRoot = path.join(os.homedir(), ".claude", "skills");
  const disabledRoot = path.join(os.homedir(), ".claude", "skills-disabled");
  const [active, disabled] = await Promise.all([
    walkSkillsRoot(activeRoot, "user", { ctx }),
    walkSkillsRoot(disabledRoot, "user", { ctx, disabled: true }),
  ]);
  return [...active, ...disabled];
}

export async function walkPluginSkills(ctx: ProvenanceContext): Promise<SkillEntry[]> {
  // Entries travel with the plugin root that produced them: an id collision
  // below can only be resolved by knowing WHERE each skill came from, and that
  // is lost once the walk returns a flat list.
  const all: Array<{ entry: SkillEntry; installPath: string }> = [];

  await Promise.all(
    ctx.installedPlugins.map(async ({ pluginName, installPath }) => {
      const roots = await resolvePluginSkillsRoots(installPath);
      for (const skillsDir of roots) {
        try {
          await fs.access(skillsDir);
        } catch {
          continue;
        }
        // A root that is ITSELF a bundled skill (`"skills": "."` on a repo that
        // is one skill) has no child directory to descend into, so the
        // directory walk below finds nothing. Check the root's own SKILL.md
        // first, and skip the walk when it hits — otherwise a plugin laid out
        // that way would also re-report every sibling directory as a skill.
        const rootSkillMd = path.join(skillsDir, "SKILL.md");
        try {
          const [text, stat] = await Promise.all([
            fs.readFile(rootSkillMd, "utf-8"),
            fs.stat(rootSkillMd),
          ]);
          all.push({
            entry: makeSkillEntry(rootSkillMd, text, "plugin", "bundled", {
              pluginName,
              ctx,
              mtime: stat.mtime,
              ctime: stat.ctime,
            }),
            installPath,
          });
          continue;
        } catch {
          // Ordinary directory-of-skills layout.
        }
        for (const entry of await walkSkillsRoot(skillsDir, "plugin", { pluginName, ctx })) {
          all.push({ entry, installPath });
        }
      }
    })
  );

  // Roots can overlap — a declared `"skills": "./skills/foo"` sits inside the
  // always-included conventional `skills/`, so both walks find the same
  // SKILL.md and the catalog shows it twice (Codex review of #384, on the
  // additive-roots fix from the previous round). Dedupe on the file that
  // produced the entry, which is the real identity; `id` is derived from the
  // slug and would collide for genuinely distinct skills of the same name in
  // different plugins.
  // Resolved on the filesystem, not inferred from how the walk classified the
  // entry. `skills/foo -> ../extra/foo` with `extra` also declared as a root is
  // one file reached by two lexical paths, and it must collapse to one row.
  //
  // `entry.realPath` alone is not enough: it is populated only in the
  // `isSymbolicLink()` branch, and **Windows junctions land in the
  // `isDirectory()` branch instead**, so on the platform this project primarily
  // targets the field stays undefined and both copies survive. CI caught that
  // on verify-windows while Linux passed, because the same fixture is a true
  // symlink there (Codex review of #384, then #392's CI).
  //
  // One `realpath` per plugin skill, which is the same order as the file reads
  // already done, and it falls back to the lexical path when resolution fails.
  const keys = await Promise.all(
    all.map(({ entry }) =>
      fs
        .realpath(entry.filePath)
        .catch(() => entry.realPath ?? entry.filePath)
        .then((p) => path.resolve(p))
    )
  );

  const seenFiles = new Set<string>();
  const unique = all.filter((_, i) => {
    if (seenFiles.has(keys[i])) return false;
    seenFiles.add(keys[i]);
    return true;
  });

  // Distinct files can still land on the same id: `makeSkillEntry` derives it
  // from plugin + layout + directory basename, so two declared roots each
  // holding a `foo/SKILL.md` produce one id for two skills. Those survive the
  // path dedupe above (different files) and then collide in every id-keyed
  // consumer — `catalog.skills.find` opens whichever comes first, so the detail
  // page can show a different skill than the row that was clicked (Codex
  // review, #384).
  //
  // Only collisions are qualified. Rewriting every id would churn ids that are
  // already stable and correct for the overwhelmingly common single-root
  // plugin, and ids appear in URLs.
  const idCounts = new Map<string, number>();
  for (const { entry } of unique) {
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  }

  return unique.map(({ entry, installPath }) => {
    if ((idCounts.get(entry.id) ?? 0) < 2) return entry;
    // The plugin-relative directory is what actually differs between the two,
    // and it is stable: unlike an ordinal suffix, it does not renumber when an
    // unrelated skill is added or removed.
    const relDir = path.relative(installPath, path.dirname(entry.filePath));
    const qualifier = relDir.split(/[\\/]/).filter(Boolean).join("-").toLowerCase();
    return qualifier ? { ...entry, id: `${entry.id}@${qualifier}` } : entry;
  });
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
