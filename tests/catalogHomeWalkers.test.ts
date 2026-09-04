import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { walkUserAgents, walkInstalledAgents, walkProjectAgents } from "@/lib/indexer/walkAgents";
import { walkUserSkills } from "@/lib/indexer/walkSkills";
import { mergeUserAgents } from "@/lib/indexer/catalog";
import { normalizePathKey } from "@/lib/platform";
import type { ProvenanceContext } from "@/lib/indexer/types";

/**
 * The catalog walkers over a home that is NOT `os.homedir()` (#553). These
 * cover what the Environments inventory's own agents/skills reader used to
 * cover before it was retired in favour of the catalog: recursion with
 * frontmatter names, dotfile and non-markdown skipping, the sibling
 * `~/.agents/agents` root and the by-file merge with `.claude`, the depth
 * cap, both skill layouts, the disabled root, and a directory link installed
 * into `skills/`.
 */
let tmp: string;
let home: string;
let linked = false;

async function write(rel: string, content: string) {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

function ctxFor(homePath: string): ProvenanceContext {
  return { installedPlugins: [], lockfile: new Map(), marketplaceRepo: new Map(), homeKey: normalizePathKey(homePath) };
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "minder-cat-"));
  home = path.join(tmp, ".claude");
  await write(".claude/agents/reviewer.md", "---\nname: Reviewer\ndescription: Reviews diffs\n---\nbody");
  await write(".claude/agents/nested/planner.md", "no frontmatter");
  await write(".claude/agents/.hidden.md", "---\nname: hidden\n---");
  await write(".claude/agents/notes.txt", "ignored");
  await write(".agents/agents/installed-only.md", "---\nname: Installed\n---");
  await write(".agents/agents/reviewer.md", "---\nname: Shadowed\n---");
  await write(".agents/agents/a/b/c/d/e/f/g/too-deep.md", "");
  await write(".claude/skills/pr-resolve/SKILL.md", "---\nname: PR Resolve\n---");
  await write(".claude/skills/not-a-skill/README.md", "no SKILL.md here");
  await write(".claude/skills/standalone.md", "---\nname: Standalone\n---");
  await write(".claude/skills-disabled/legacy/SKILL.md", "");
  await write("elsewhere/linked-skill/SKILL.md", "---\nname: Linked\n---");
  try {
    await fs.symlink(path.join(tmp, "elsewhere", "linked-skill"), path.join(home, "skills", "linked-skill"), "junction");
    linked = true;
  } catch {
    linked = false;
  }
  await write("repo/.claude/agents/local.md", "---\nname: Local\n---");
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("walkUserAgents(ctx, home)", () => {
  it("walks <home>/agents recursively, reading frontmatter, skipping dotfiles and non-markdown", async () => {
    const agents = await walkUserAgents(ctxFor(home), home);
    expect(agents.map((a) => [a.slug, a.name, a.description]).sort()).toEqual([
      ["planner", "planner", undefined],
      ["reviewer", "Reviewer", "Reviews diffs"],
    ]);
  });

  it("stamps the context's homeKey on every user entry", async () => {
    const agents = await walkUserAgents(ctxFor(home), home);
    expect(agents.every((a) => a.homeKey === normalizePathKey(home))).toBe(true);
  });

  it("stamps nothing when the context names no home (pre-#553 callers)", async () => {
    const agents = await walkUserAgents({ installedPlugins: [], lockfile: new Map(), marketplaceRepo: new Map() }, home);
    expect(agents.every((a) => a.homeKey === undefined)).toBe(true);
  });
});

describe("walkInstalledAgents(ctx, home)", () => {
  it("reads the sibling ~/.agents/agents root beside the home, within the depth cap", async () => {
    const agents = await walkInstalledAgents(ctxFor(home), home);
    expect(agents.map((a) => a.slug).sort()).toEqual(["installed-only", "reviewer"]);
    expect(agents.some((a) => a.slug === "too-deep")).toBe(false);
  });

  it("merges the two roots by FILE, so two distinct files sharing a slug both survive", async () => {
    // The catalog's rule (pre-#553, unchanged): `mergeUserAgents` drops an
    // installed entry only when it is the same file the .claude root already
    // reached through a symlink. `reviewer.md` here is two different files, and
    // both are listed — the diff keys rows by provider and slug, so the pair
    // collapses to one row there.
    const merged = mergeUserAgents(
      await walkUserAgents(ctxFor(home), home),
      await walkInstalledAgents(ctxFor(home), home)
    );
    expect(merged.filter((a) => a.slug === "reviewer").map((a) => a.name).sort()).toEqual(["Reviewer", "Shadowed"]);
    expect(merged.map((a) => a.slug).sort()).toEqual(["installed-only", "planner", "reviewer", "reviewer"]);
  });
});

describe("walkUserSkills(ctx, home)", () => {
  it("lists bundled and standalone skills from <home>/skills and marks the disabled root", async () => {
    const skills = await walkUserSkills(ctxFor(home), home);
    const rows = skills
      .filter((s) => s.slug !== "linked-skill")
      .map((s) => ({ slug: s.slug, name: s.name, layout: s.layout, disabled: s.disabled }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    expect(rows).toEqual([
      { slug: "legacy", name: "legacy", layout: "bundled", disabled: true },
      { slug: "pr-resolve", name: "PR Resolve", layout: "bundled", disabled: undefined },
      { slug: "standalone", name: "Standalone", layout: "standalone", disabled: undefined },
    ]);
    expect(skills.every((s) => s.homeKey === normalizePathKey(home))).toBe(true);
  });

  it("follows a directory link installed into skills/", async () => {
    if (!linked) return; // link creation refused on this machine
    const skills = await walkUserSkills(ctxFor(home), home);
    expect(skills.find((s) => s.slug === "linked-skill")?.name).toBe("Linked");
  });
});

describe("project entries", () => {
  it("carry no homeKey — they are repo-borne", async () => {
    const agents = await walkProjectAgents(path.join(tmp, "repo"), "repo", ctxFor(home));
    expect(agents.map((a) => a.slug)).toEqual(["local"]);
    expect(agents[0].homeKey).toBeUndefined();
  });
});
