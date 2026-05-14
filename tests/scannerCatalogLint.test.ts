import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkillEntry, AgentEntry, ProvenanceContext } from "@/lib/indexer/types";
import type { ProjectData } from "@/lib/types";

vi.mock("@/lib/indexer/catalog", () => ({
  loadCatalog: vi.fn(),
}));
vi.mock("@/lib/indexer/walkAgents", () => ({
  walkProjectAgents: vi.fn(),
}));
vi.mock("@/lib/indexer/walkSkills", () => ({
  walkProjectSkills: vi.fn(),
}));
vi.mock("@/lib/indexer/walkCommands", () => ({
  walkUserCommands: vi.fn(),
  walkPluginCommands: vi.fn(),
  walkProjectCommands: vi.fn(),
}));
vi.mock("@/lib/userConfigCache", () => ({
  getUserConfig: vi.fn(),
}));

import { runCatalogLint } from "@/lib/scanner/catalogLint";
import { loadCatalog } from "@/lib/indexer/catalog";
import { walkProjectAgents } from "@/lib/indexer/walkAgents";
import { walkProjectSkills } from "@/lib/indexer/walkSkills";
import { walkUserCommands, walkPluginCommands, walkProjectCommands } from "@/lib/indexer/walkCommands";
import { getUserConfig } from "@/lib/userConfigCache";

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    kind: "skill",
    id: "skill:user:user:s",
    slug: "s",
    name: "my-skill",
    source: "user",
    filePath: "/home/.claude/skills/s/SKILL.md",
    bodyExcerpt: "",
    frontmatter: {},
    mtime: new Date().toISOString(),
    ctime: new Date().toISOString(),
    layout: "bundled",
    provenance: { kind: "user-local" },
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    kind: "agent",
    id: "agent:user:user:a",
    slug: "a",
    name: "my-agent",
    source: "user",
    filePath: "/home/.claude/agents/a.md",
    bodyExcerpt: "",
    frontmatter: {},
    mtime: new Date().toISOString(),
    ctime: new Date().toISOString(),
    provenance: { kind: "user-local" },
    ...overrides,
  };
}

const EMPTY_CTX: ProvenanceContext = {
  installedPlugins: [],
  lockfile: new Map(),
  marketplaceRepo: new Map(),
};

const EMPTY_USER_CFG = { plugins: { plugins: [] } };

function stubMocks(catalog: { skills: SkillEntry[]; agents: AgentEntry[] } = { skills: [], agents: [] }) {
  vi.mocked(loadCatalog).mockResolvedValue(catalog as Awaited<ReturnType<typeof loadCatalog>>);
  vi.mocked(walkProjectAgents).mockResolvedValue([]);
  vi.mocked(walkProjectSkills).mockResolvedValue([]);
  vi.mocked(walkUserCommands).mockResolvedValue([]);
  vi.mocked(walkPluginCommands).mockResolvedValue([]);
  vi.mocked(walkProjectCommands).mockResolvedValue([]);
  vi.mocked(getUserConfig).mockResolvedValue(EMPTY_USER_CFG as unknown as Awaited<ReturnType<typeof getUserConfig>>);
}

const PROJECTS: ProjectData[] = [];
const FLAGS_ON = { configLint: true } as Record<string, boolean>;
const FLAGS_OFF = { configLint: false } as Record<string, boolean>;

describe("runCatalogLint", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns empty array when configLint flag is off", async () => {
    stubMocks();
    const findings = await runCatalogLint(PROJECTS, FLAGS_OFF, EMPTY_CTX);
    expect(findings).toEqual([]);
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("returns empty array (graceful) when loadCatalog throws", async () => {
    vi.mocked(loadCatalog).mockRejectedValue(new Error("disk error"));
    vi.mocked(walkProjectAgents).mockResolvedValue([]);
    vi.mocked(walkProjectSkills).mockResolvedValue([]);
    vi.mocked(walkUserCommands).mockResolvedValue([]);
    vi.mocked(walkPluginCommands).mockResolvedValue([]);
    vi.mocked(getUserConfig).mockResolvedValue(EMPTY_USER_CFG as unknown as Awaited<ReturnType<typeof getUserConfig>>);

    const findings = await runCatalogLint(PROJECTS, FLAGS_ON, EMPTY_CTX);
    expect(findings).toEqual([]);
  });

  it("returns findings for user-scope skill with no description", async () => {
    stubMocks({ skills: [makeSkill({ description: undefined })], agents: [] });
    const findings = await runCatalogLint(PROJECTS, FLAGS_ON, EMPTY_CTX);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].code).toBe("skill/missing-description");
  });

  it("does not emit structural findings for project-scope entries", async () => {
    const projectSkill = makeSkill({ source: "project", description: undefined });
    stubMocks({ skills: [projectSkill], agents: [] });
    const findings = await runCatalogLint(PROJECTS, FLAGS_ON, EMPTY_CTX);
    expect(findings.filter((f) => f.code === "skill/missing-description")).toHaveLength(0);
  });

  it("emits duplicate-name finding across scopes", async () => {
    const user = makeSkill({ name: "shared", source: "user" });
    const project = makeSkill({ name: "shared", source: "project", description: "ok" });
    stubMocks({ skills: [user, project], agents: [] });
    const findings = await runCatalogLint(PROJECTS, FLAGS_ON, EMPTY_CTX);
    expect(findings.some((f) => f.code === "skill/duplicate-name")).toBe(true);
  });

  it("returns findings for user-scope agent with no description", async () => {
    stubMocks({ skills: [], agents: [makeAgent({ description: undefined })] });
    const findings = await runCatalogLint(PROJECTS, FLAGS_ON, EMPTY_CTX);
    expect(findings.some((f) => f.code === "agent/missing-description")).toBe(true);
  });
});
