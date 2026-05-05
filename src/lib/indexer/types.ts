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
}

export type CatalogEntry = AgentEntry | SkillEntry;

export interface CatalogResult {
  agents: AgentEntry[];
  skills: SkillEntry[];
}
