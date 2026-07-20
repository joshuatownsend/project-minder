import { describe, it, expect } from "vitest";
import { generateSeedCandidates } from "@/lib/memory/seedGenerator";
import { parseFrontmatter } from "@/lib/memory/memoryFrontmatter";
import type { ProjectData } from "@/lib/types";

function project(opts: Partial<ProjectData> & { slug: string; path: string; name?: string }): ProjectData {
  return {
    slug: opts.slug,
    usageSlug: opts.usageSlug ?? `dev-${opts.slug}`,
    usageDirName: `C--dev-${opts.slug}`,
    name: opts.name ?? opts.slug,
    path: opts.path,
    status: opts.status ?? "active",
    framework: opts.framework,
    frameworkVersion: opts.frameworkVersion,
    orm: opts.orm,
    styling: opts.styling,
    dependencies: opts.dependencies ?? [],
    dockerPorts: opts.dockerPorts ?? [],
    externalServices: opts.externalServices ?? [],
    devPort: opts.devPort,
    database: opts.database,
    git: opts.git,
    lastActivity: opts.lastActivity ?? "2026-05-01T00:00:00Z",
    scannedAt: opts.scannedAt ?? "2026-05-11T00:00:00Z",
    claudeMdAudit: opts.claudeMdAudit ?? {
      hasClaudeMd: true,
      score: 80,
      projectLines: 100,
      importCount: 0,
      fileBytes: 2000,
      rulesLines: 50,
      rulesFileCount: 1,
      findings: [],
    },
  };
}

describe("generateSeedCandidates", () => {
  it("returns empty when no inputs are available", () => {
    const out = generateSeedCandidates({
      userClaudeMd: null,
      projects: [],
      sessionCategories: new Map(),
    });
    expect(out).toEqual([]);
  });

  it("produces user_role.md when global CLAUDE.md is present", () => {
    const out = generateSeedCandidates({
      userClaudeMd: "I am a developer working on multiple projects.\n\nI prefer terse responses.",
      projects: [],
      sessionCategories: new Map(),
    });
    const role = out.find((c) => c.fileName === "user_role.md");
    expect(role).toBeDefined();
    expect(role?.type).toBe("user");
    expect(role?.scope).toBe("user");
    expect(role?.targetProjectPath).toBeNull();
    expect(role?.provenance).toContain("~/.claude/CLAUDE.md");
  });

  it("produces user_workstyle.md when session categories are present", () => {
    const out = generateSeedCandidates({
      userClaudeMd: null,
      projects: [],
      sessionCategories: new Map([
        ["Feature Dev", 100],
        ["Refactoring", 30],
        ["Testing", 5],
      ]),
    });
    const ws = out.find((c) => c.fileName === "user_workstyle.md");
    expect(ws).toBeDefined();
    expect(ws?.body).toContain("Feature Dev");
    expect(ws?.body).toContain("74%"); // 100/(100+30+5) ≈ 74%
  });

  it("produces reference_repos.md aggregating active repos", () => {
    const out = generateSeedCandidates({
      userClaudeMd: null,
      projects: [
        project({ slug: "alpha", path: "C:\\dev\\alpha", framework: "Next.js", devPort: 3000 }),
        project({ slug: "beta", path: "C:\\dev\\beta", framework: "Vite", status: "archived" }),
      ],
      sessionCategories: new Map(),
    });
    const repos = out.find((c) => c.fileName === "reference_repos.md");
    expect(repos).toBeDefined();
    expect(repos?.body).toContain("alpha");
    // Archived project should not appear in the aggregate.
    expect(repos?.body).not.toContain("beta");
  });

  it("produces reference_dev_environment.md from aggregate signals", () => {
    const out = generateSeedCandidates({
      userClaudeMd: null,
      projects: [
        project({ slug: "a", path: "C:\\dev\\a", framework: "Next.js", styling: "Tailwind CSS" }),
        project({ slug: "b", path: "C:\\dev\\b", framework: "Next.js", styling: "Tailwind CSS" }),
      ],
      sessionCategories: new Map(),
    });
    const env = out.find((c) => c.fileName === "reference_dev_environment.md");
    expect(env).toBeDefined();
    expect(env?.body).toMatch(/Next\.js \(2\)/);
    expect(env?.body).toMatch(/Tailwind CSS \(2\)/);
  });

  it("produces a project_<slug>.md per active scanned project (cap = 10)", () => {
    const projects = Array.from({ length: 15 }, (_, i) =>
      project({
        slug: `p${i}`,
        path: `C:\\dev\\p${i}`,
        lastActivity: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const out = generateSeedCandidates({
      userClaudeMd: null,
      projects,
      sessionCategories: new Map(),
    });
    const projectSeeds = out.filter((c) => c.fileName.startsWith("project_"));
    expect(projectSeeds).toHaveLength(10);
    // Sorted by lastActivity desc -- p14 should be present, p4 should not.
    expect(projectSeeds.find((c) => c.fileName === "project_p14.md")).toBeDefined();
    expect(projectSeeds.find((c) => c.fileName === "project_p4.md")).toBeUndefined();
  });

  it("skips projects without CLAUDE.md (no convention base to seed from)", () => {
    const out = generateSeedCandidates({
      userClaudeMd: null,
      projects: [
        project({
          slug: "no-claude-md",
          path: "C:\\dev\\nope",
          claudeMdAudit: { hasClaudeMd: false, findings: [] },
        }),
      ],
      sessionCategories: new Map(),
    });
    expect(out.find((c) => c.fileName.startsWith("project_"))).toBeUndefined();
  });

  it("attaches per-project targetProjectPath but leaves user-scope null", () => {
    const out = generateSeedCandidates({
      userClaudeMd: "I am josh.",
      projects: [project({ slug: "alpha", path: "C:\\dev\\alpha" })],
      sessionCategories: new Map([["Feature Dev", 10]]),
    });
    const role = out.find((c) => c.fileName === "user_role.md");
    const projectSeed = out.find((c) => c.fileName === "project_alpha.md");
    expect(role?.targetProjectPath).toBeNull();
    expect(projectSeed?.targetProjectPath).toBe("C:\\dev\\alpha");
  });

  it("composes bodies with valid frontmatter (parses cleanly through memoryFrontmatter)", () => {
    const out = generateSeedCandidates({
      userClaudeMd: "I am josh.",
      projects: [project({ slug: "alpha", path: "C:\\dev\\alpha" })],
      sessionCategories: new Map(),
    });
    for (const c of out) {
      const parsed = parseFrontmatter(c.body);
      expect("error" in parsed, `parse failed for ${c.fileName}`).toBe(false);
      if (!("error" in parsed)) {
        expect(parsed.data.type).toBe(c.type);
        expect(parsed.data.seeded).toBe(true);
        expect(parsed.data.derived_from).toEqual(c.provenance);
      }
    }
  });

  it("tolerates Date objects in lastActivity (cached scans hold non-string dates)", () => {
    // Repro of the production 500 on /memory/seed: the in-memory scan cache
    // can carry Date instances even though ProjectData.lastActivity is typed
    // as string. The generator must coerce defensively.
    const out = generateSeedCandidates({
      userClaudeMd: null,
      projects: [
        project({
          slug: "a",
          path: "C:\\dev\\a",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastActivity: new Date("2026-05-10T00:00:00Z") as any,
        }),
        project({
          slug: "b",
          path: "C:\\dev\\b",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastActivity: new Date("2026-05-11T00:00:00Z") as any,
        }),
      ],
      sessionCategories: new Map(),
    });
    const seeds = out.filter((c) => c.fileName.startsWith("project_"));
    expect(seeds).toHaveLength(2);
    // b sorts before a (more-recent date wins)
    expect(seeds[0].fileName).toBe("project_b.md");
    expect(seeds[1].fileName).toBe("project_a.md");
    // ISO-stringified into the body, not "[object Date]"
    expect(seeds[0].body).toContain("2026-05-11T00:00:00.000Z");
  });

  it("composed bodies pass prefix↔type validation (writer would accept)", async () => {
    const { validateTypedMemory } = await import("@/lib/memory/memoryFrontmatter");
    const out = generateSeedCandidates({
      userClaudeMd: "I am josh.",
      projects: [project({ slug: "alpha", path: "C:\\dev\\alpha" })],
      sessionCategories: new Map([["Feature Dev", 10]]),
    });
    for (const c of out) {
      const parsed = parseFrontmatter(c.body);
      if ("error" in parsed) throw new Error(`unexpected error for ${c.fileName}`);
      const err = validateTypedMemory(c.fileName, parsed.data);
      expect(err, `validation failed for ${c.fileName}`).toBeNull();
    }
  });
});
