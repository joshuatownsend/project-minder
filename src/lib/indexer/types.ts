export type CatalogSource = "user" | "plugin" | "project";

export type Provenance =
  | {
      kind: "marketplace-plugin";
      pluginName: string;
      marketplace: string;
      marketplaceRepo?: string;   // e.g. "anthropics/claude-plugins-official"
      pluginVersion?: string;
      gitCommitSha?: string;
      installedAt?: string;
      lastUpdated?: string;
      pluginRepoUrl?: string;     // from .claude-plugin/plugin.json .repository
    }
  | {
      kind: "lockfile";
      source: string;             // e.g. "clerk/skills"
      sourceType: string;         // e.g. "github"
      sourceUrl: string;          // e.g. "https://github.com/clerk/skills.git"
      skillPath: string;          // e.g. "skills/clerk/SKILL.md"
      skillFolderHash: string;
      installedAt: string;
      updatedAt: string;
      symlinkTarget?: string;     // resolved real path if entry was a symlink
    }
  | { kind: "user-local" }
  | { kind: "project-local"; projectSlug: string };

export interface LockfileEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

export interface InstalledPlugin {
  pluginName: string;
  installPath: string;
  marketplace: string;
  scope?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
  pluginRepoUrl?: string;   // from .claude-plugin/plugin.json .repository
}

export interface ProvenanceContext {
  installedPlugins: InstalledPlugin[];
  lockfile: Map<string, LockfileEntry>;
  marketplaceRepo: Map<string, string>; // marketplace name → "owner/repo"
}

interface CatalogEntryBase {
  id: string;
  slug: string;
  name: string;
  description?: string;
  source: CatalogSource;
  pluginName?: string;
  projectSlug?: string;
  category?: string;
  filePath: string;
  bodyExcerpt: string;
  frontmatter: Record<string, unknown>;
  mtime: string;
  ctime: string;
  provenance: Provenance;
  isSymlink?: boolean;
  realPath?: string;
  parseWarnings?: string[];
  /** UTF-8 byte count of the source markdown (SKILL.md, agent .md, etc.).
   *  Captured at walk time when the body is already in memory so both the
   *  portfolio-wide token estimator (`src/lib/contextOverhead.ts`) and the
   *  per-row catalog chip (`src/lib/usage/tokenEstimate.ts`, T2.1) can
   *  derive a token estimate without a second fs pass. */
  fileBytes?: number;
  /** Projected per-invocation context cost (T2.1). Populated at the
   *  catalog API/MCP layer (`withProjectedContextCost` in
   *  `src/lib/usage/tokenEstimate.ts`), not by the indexer — so the
   *  context-window denominator can come from the active model rather
   *  than being fixed at walk time. Absent when `fileBytes` is missing
   *  or rounds to zero tokens. */
  projectedContextCost?: {
    tokenEstimate: number;
    contextWindowPercent: number;
  };
}

export interface AgentEntry extends CatalogEntryBase {
  kind: "agent";
  model?: string;
  tools?: string[];
  color?: string;
  emoji?: string;
}

export interface SkillEntry extends CatalogEntryBase {
  kind: "skill";
  layout: "bundled" | "standalone";
  version?: string;
  userInvocable?: boolean;
  argumentHint?: string;
  description?: string;
  /** True when the skill lives in ~/.claude/skills-disabled/ and is excluded from Claude Code. */
  disabled?: boolean;
}

/**
 * A harness-native instruction artifact (Codex `rules`/`AGENTS.md`/`prompts`,
 * Gemini context files, etc.) — distinct from Claude agent/skill profiles, so
 * it lives in its own catalog rather than `AgentEntry`/`SkillEntry`. `harness`
 * names the owning tool; `source` keeps its usual meaning (filesystem origin),
 * which for these is always `"user"` (the harness config home).
 */
export interface InstructionEntry extends CatalogEntryBase {
  kind: "instruction";
  harness: "claude" | "codex" | "gemini";
}

export type CatalogEntry = AgentEntry | SkillEntry;

export interface CatalogResult {
  agents: AgentEntry[];
  skills: SkillEntry[];
}
