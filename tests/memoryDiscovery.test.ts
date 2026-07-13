import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { ProjectData } from "@/lib/types";

// `listMemoryFiles` discovery + stale heuristic. Uses a real tmpdir because
// the broken-import detection delegates to `expandImports`, which itself
// reads files; mocking `fs` would force us to mirror that contract here and
// silently drift. The tmpdir is small (a handful of CLAUDE.md files) so the
// test stays fast.

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function reloadModule() {
  vi.resetModules();
  delete (globalThis as { __memoryInventoryCache?: unknown }).__memoryInventoryCache;
  delete (globalThis as { __memoryImportCache?: unknown }).__memoryImportCache;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return await import("@/lib/memory");
}

function project(slug: string, projectPath: string): ProjectData {
  return {
    slug,
    usageSlug: `dev-${slug}`,
    name: slug,
    path: projectPath,
    status: "active",
    dependencies: [],
    dockerPorts: [],
    externalServices: [],
    scannedAt: new Date().toISOString(),
    // Discriminated union — absent variant is the "no CLAUDE.md scanned"
    // default for tests that don't care about audit data.
    claudeMdAudit: { hasClaudeMd: false, findings: [] },
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "minder-mem-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });
  await fs.mkdir(path.join(tmpHome, ".claude", "projects"), { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  vi.restoreAllMocks();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe("listMemoryFiles — discovery", () => {
  it("includes user CLAUDE.md when present", async () => {
    await fs.writeFile(path.join(tmpHome, ".claude", "CLAUDE.md"), "# user\n");
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [] });
    expect(entries.filter((e) => e.scope === "user")).toHaveLength(1);
    expect(entries[0].displayName).toBe("User CLAUDE.md");
  });

  it("skips user scope when ~/.claude/CLAUDE.md is missing", async () => {
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [] });
    expect(entries.filter((e) => e.scope === "user")).toHaveLength(0);
  });

  it("includes one project entry per scanned project that has a CLAUDE.md", async () => {
    const a = path.join(tmpHome, "projA");
    const b = path.join(tmpHome, "projB");
    await fs.mkdir(a); await fs.mkdir(b);
    await fs.writeFile(path.join(a, "CLAUDE.md"), "# A\n");
    // B has no CLAUDE.md
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [project("a", a), project("b", b)] });
    const proj = entries.filter((e) => e.scope === "project");
    expect(proj).toHaveLength(1);
    expect(proj[0].projectSlug).toBe("a");
  });

  it("includes auto-memory .md files and skips non-md or dotfiles", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    // Match the encodePath shape: `C:\dev\projA` → `c--dev-projA`-style; we
    // use the actual encoder by importing memoryWriter through the module.
    const { encodePath } = await import("@/lib/scanner/claudeConversations");
    const memDir = path.join(tmpHome, ".claude", "projects", encodePath(a), "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "user_role.md"), "user info");
    await fs.writeFile(path.join(memDir, "feedback.md"), "feedback info");
    await fs.writeFile(path.join(memDir, "ignored.json"), "{}");
    await fs.writeFile(path.join(memDir, ".hidden.md"), "hidden");

    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [project("a", a)] });
    const auto = entries.filter((e) => e.scope === "auto");
    expect(auto.map((e) => e.displayName).sort()).toEqual(["feedback.md", "user_role.md"]);
    for (const e of auto) expect(e.projectSlug).toBe("a");
  });
});

describe("listMemoryFiles — MEMORY.md index awareness", () => {
  it("returns an indexSummary per project with a memory dir", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    const { encodePath } = await import("@/lib/scanner/claudeConversations");
    const memDir = path.join(tmpHome, ".claude", "projects", encodePath(a), "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "MEMORY.md"), "- [Alpha](alpha.md) — first\n");
    await fs.writeFile(path.join(memDir, "alpha.md"), "alpha body");
    await fs.writeFile(path.join(memDir, "orphan.md"), "orphan body");

    const { listMemoryFiles } = await reloadModule();
    const { entries, indexSummaries } = await listMemoryFiles({ projects: [project("a", a)] });

    expect(indexSummaries).toHaveLength(1);
    expect(indexSummaries[0].projectSlug).toBe("a");
    expect(indexSummaries[0].present).toBe(true);
    expect(indexSummaries[0].entryCount).toBe(1);
    expect(indexSummaries[0].orphans).toEqual(["orphan.md"]);
    expect(indexSummaries[0].dangling).toEqual([]);

    const alpha = entries.find((e) => e.displayName === "alpha.md");
    const orphan = entries.find((e) => e.displayName === "orphan.md");
    expect(alpha?.indexed).toBe(true);
    expect(orphan?.indexed).toBe(false);
  });

  it("omits indexSummary when project has memory dir but no MEMORY.md", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    const { encodePath } = await import("@/lib/scanner/claudeConversations");
    const memDir = path.join(tmpHome, ".claude", "projects", encodePath(a), "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "user_role.md"), "stuff");

    const { listMemoryFiles } = await reloadModule();
    const { entries, indexSummaries } = await listMemoryFiles({ projects: [project("a", a)] });

    expect(indexSummaries).toHaveLength(0);
    const auto = entries.find((e) => e.scope === "auto");
    // Without an index we leave `indexed` undefined — UI shows neutral state.
    expect(auto?.indexed).toBeUndefined();
  });

  it("detects dangling links when MEMORY.md points at missing files", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    const { encodePath } = await import("@/lib/scanner/claudeConversations");
    const memDir = path.join(tmpHome, ".claude", "projects", encodePath(a), "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(memDir, "MEMORY.md"),
      "- [Gone](missing.md) — points at nothing\n",
    );

    const { listMemoryFiles } = await reloadModule();
    const { indexSummaries } = await listMemoryFiles({ projects: [project("a", a)] });

    expect(indexSummaries[0].dangling).toEqual(["missing.md"]);
    expect(indexSummaries[0].orphans).toEqual([]);
  });
});

describe("listMemoryFiles — staleness", () => {
  it("flags files mtime > 30d as ageOver30d", async () => {
    const userMd = path.join(tmpHome, ".claude", "CLAUDE.md");
    await fs.writeFile(userMd, "# old\n");
    const old = (Date.now() - 31 * 24 * 60 * 60_000) / 1000;
    await fs.utimes(userMd, old, old);
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [] });
    expect(entries[0].stale.ageOver30d).toBe(true);
  });

  it("reports broken @import refs", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    await fs.writeFile(
      path.join(a, "CLAUDE.md"),
      "# project\n\n@import ./missing-target.md\n",
    );
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [project("a", a)] });
    const proj = entries.find((e) => e.scope === "project");
    expect(proj?.stale.brokenImports).toEqual(["./missing-target.md"]);
  });

  it("flags broken prose refs as brokenRefs", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    // Two refs in the body: one resolves, one doesn't.
    await fs.mkdir(path.join(a, "src"));
    await fs.writeFile(path.join(a, "src", "ok.ts"), "x");
    await fs.writeFile(
      path.join(a, "CLAUDE.md"),
      "see src/ok.ts (exists) and src/missing.ts (gone)\n",
    );
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [project("a", a)] });
    const proj = entries.find((e) => e.scope === "project");
    expect(proj?.stale.brokenRefs).toEqual(["src/missing.ts"]);
  });

  it("does not flag working @import refs", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    await fs.writeFile(path.join(a, "rules.md"), "# rules\n");
    await fs.writeFile(
      path.join(a, "CLAUDE.md"),
      "# project\n\n@import ./rules.md\n",
    );
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [project("a", a)] });
    const proj = entries.find((e) => e.scope === "project");
    expect(proj?.stale.brokenImports).toEqual([]);
  });
});

describe("listMemoryFiles — preview + sorting", () => {
  it("strips frontmatter from preview", async () => {
    await fs.writeFile(
      path.join(tmpHome, ".claude", "CLAUDE.md"),
      "---\nname: x\n---\nThe real content starts here.\n",
    );
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [] });
    expect(entries[0].preview).toMatch(/^The real content/);
  });

  it("sorts user → project → auto", async () => {
    const a = path.join(tmpHome, "projA");
    await fs.mkdir(a);
    await fs.writeFile(path.join(tmpHome, ".claude", "CLAUDE.md"), "u");
    await fs.writeFile(path.join(a, "CLAUDE.md"), "p");
    const { encodePath } = await import("@/lib/scanner/claudeConversations");
    const memDir = path.join(tmpHome, ".claude", "projects", encodePath(a), "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "x.md"), "auto");
    const { listMemoryFiles } = await reloadModule();
    const { entries } = await listMemoryFiles({ projects: [project("a", a)] });
    expect(entries.map((e) => e.scope)).toEqual(["user", "project", "auto"]);
  });
});

describe("encodeMemoryId / decodeMemoryId", () => {
  it("round-trips POSIX absolute paths through base64url", async () => {
    await reloadModule();
    const { encodeMemoryId, decodeMemoryId } = await import("@/lib/memory/safety");
    const inputs = ["/Users/joshu/.claude/CLAUDE.md", "/tmp/spaces in path/file.md"];
    for (const p of inputs) {
      expect(decodeMemoryId(encodeMemoryId(p))).toBe(p);
    }
  });

  // path.isAbsolute is platform-aware: Windows-style paths only count as
  // absolute on win32. Skip on POSIX CI to keep the round-trip semantic
  // honest rather than swallowing the platform difference.
  it.skipIf(process.platform !== "win32")(
    "round-trips Windows absolute paths through base64url",
    async () => {
      await reloadModule();
      const { encodeMemoryId, decodeMemoryId } = await import("@/lib/memory/safety");
      const p = "C:\\dev\\project-minder\\CLAUDE.md";
      expect(decodeMemoryId(encodeMemoryId(p))).toBe(p);
    },
  );

  it("rejects malformed ids", async () => {
    await reloadModule();
    const { decodeMemoryId } = await import("@/lib/memory/safety");
    const id = Buffer.from("foo\0bar", "utf-8").toString("base64url");
    expect(decodeMemoryId(id)).toBeNull();
  });

  it("rejects relative paths even when base64url decodes cleanly", async () => {
    await reloadModule();
    const { decodeMemoryId } = await import("@/lib/memory/safety");
    const id = Buffer.from("relative/path.md", "utf-8").toString("base64url");
    expect(decodeMemoryId(id)).toBeNull();
  });
});
