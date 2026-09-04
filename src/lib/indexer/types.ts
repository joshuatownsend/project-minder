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
  /**
   * Where the plugin's files are, AS THIS MACHINE CAN OPEN THEM. The registry
   * records the path in the home's own filesystem; for a foreign (WSL) home
   * it is rewritten through the home's path mappings (#553). When no mapping
   * covers it the raw registry path is kept and `installPathUnresolved` set.
   */
  installPath: string;
  /**
   * The registry path could not be mapped to a local path, so the plugin's
   * agents, skills and commands cannot be read from here — the walk finds
   * nothing under it. Only ever set for a non-primary home. Surfaced rather
   * than swallowed so a catalog that is quietly short can say why.
   */
  installPathUnresolved?: boolean;
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
  /**
   * The Claude home this context was loaded for (`normalizePathKey(home)`),
   * stamped onto every user- and plugin-scope entry the walkers make from
   * it. Absent on contexts built by callers that predate the home dimension
   * (tests, the template writers), which is the primary home implicitly.
   */
  homeKey?: string;
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
  /**
   * The Claude home a user- or plugin-scope entry was read from:
   * `normalizePathKey(home)`, equal to the scanner's `ProjectData.usageHomeKey`
   * for a project under that home, so a group location joins to the
   * entries its own home loads (#553). Project-scope entries are repo-borne
   * and carry none.
   */
  homeKey?: string;
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
  /**
   * Path relative to the agents root, without `.md` (`review/worker`). The
   * identity within a root — `slug` is only the file stem, so two nested
   * agents `review/worker.md` and `build/worker.md` share it. Set by the
   * directory walk; absent only on entries built without a root.
   */
  relPath?: string;
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
  /**
   * `disable-model-invocation: true` — the skill stays reachable as a slash
   * command but Claude may no longer select it on its own. Distinct from
   * `disabled`, which removes it entirely: this one narrows *who* can invoke it.
   *
   * `undefined` means the skill did not declare the key, which is not the same
   * as declaring it false — only the former is safe to omit from the UI.
   */
  disableModelInvocation?: boolean;
  /** `background: true` — the skill runs as a background task rather than inline. */
  background?: boolean;
  /** `context: fork` runs the skill in a forked context. Kept as a raw string; the vocabulary is not fixed. */
  context?: string;
  /** Reasoning effort the skill requests (`low`/`medium`/`high`/`xhigh`/`max`). */
  effort?: string;
  /** Model override the skill requests. */
  model?: string;
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
  /** The home the user/plugin walks covered. `primary` when no `home` was asked for. */
  home: { key: string; path: string; primary: boolean };
  /**
   * Installed plugins whose registry `installPath` no path mapping could
   * rewrite into a path this machine can open, so nothing under them was
   * walked (see `InstalledPlugin.installPathUnresolved`), as registry keys
   * (`name@marketplace` — the same id the environments inventory uses).
   * Always empty for the primary home.
   */
  unresolvedPlugins: string[];
}
