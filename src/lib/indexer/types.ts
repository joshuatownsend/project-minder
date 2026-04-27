export type CatalogSource = "user" | "plugin" | "project";

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
}

export type CatalogEntry = AgentEntry | SkillEntry;

export interface CatalogResult {
  agents: AgentEntry[];
  skills: SkillEntry[];
}

export interface InstalledPlugin {
  pluginName: string;
  installPath: string;
}
