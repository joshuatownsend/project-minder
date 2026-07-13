import type { SessionStatus } from "./session";
import type { ClaudeMdAuditInfo } from "./audit";
import type { LintReport, LintFinding } from "./lint";
import type { TodoInfo, ManualStepsInfo, InsightsInfo } from "./checklist";
import type { BoardInfo } from "./board";
import type { OperationsInfo } from "./ops";
import type {
  HooksInfo,
  McpServersInfo,
  OutputStylesInfo,
  LspConfigInfo,
} from "./claudeConfig";
import type { CiCdInfo } from "./cicd";

export interface ProjectData {
  slug: string;
  name: string;
  path: string;
  status: ProjectStatus;

  // The `projectSlug` key the usage module aggregates turns under — derived
  // from the `~/.claude/projects/` encoded dir name, NOT the route slug above.
  // (e.g. route slug `project-minder` ↔ usage slug `dev-project-minder`.) The
  // two diverge because usage slugs are computed from the encoded conversation
  // dir while route slugs come from the filesystem basename. Precomputed here
  // so cost/usage views can cross-reference a scanned project to its usage
  // aggregates without re-deriving the encoding client-side.
  usageSlug: string;

  // Tech stack
  framework?: string;
  frameworkVersion?: string;
  orm?: string;
  styling?: string;
  monorepoType?: string;
  dependencies: string[];

  // Ports
  devPort?: number;
  dbPort?: number;
  dockerPorts: PortMapping[];

  // Database
  database?: DatabaseInfo;

  // External services
  externalServices: string[];

  // Git
  git?: GitInfo;

  // Claude
  claude?: ClaudeInfo;

  // CLAUDE.md health audit — surfaced as a badge on ProjectCard and
  // full panel on ProjectDetail. Required: the scanner always
  // populates it as either ClaudeMdAuditAbsent (no file) or
  // ClaudeMdAuditPresent (full measurement). Consumers switch on
  // `hasClaudeMd` to access the measurement fields without `?.`.
  claudeMdAudit: ClaudeMdAuditInfo;

  // Workspace-wide config lint (skills, agents, hooks, MCPs, plugins, …).
  // Populated when the `configLint` feature flag is on; absent otherwise.
  configLint?: LintReport;

  // TODOs
  todos?: TodoInfo;

  // Manual Steps
  manualSteps?: ManualStepsInfo;

  // Insights
  insights?: InsightsInfo;

  // Board (BOARD.md epics → issues)
  board?: BoardInfo;

  // Operations runbook (OPERATIONS.md — curated facts, living-checklist)
  operations?: OperationsInfo;

  // Worktree overlays
  worktrees?: WorktreeOverlay[];

  // Claude config (project-local)
  hooks?: HooksInfo;
  mcpServers?: McpServersInfo;
  outputStyles?: OutputStylesInfo;
  lspConfig?: LspConfigInfo;

  // CI/CD
  cicd?: CiCdInfo;

  // Catalog counts (project-local agents/skills)
  agentCount?: number;
  skillCount?: number;

  // GSD project planning (.planning/ directory)
  gsdPlanning?: GsdPlanningInfo;

  // Timestamps
  lastActivity?: string;
  scannedAt: string;
}

export interface GsdPlanningInfo {
  projectName?: string;
  description?: string;
  status?: string;
  milestone?: string;
  completedPhases: number;
  totalPhases: number;
  stoppedAt?: string;
  phases: GsdPhaseEntry[];
}

export interface GsdPhaseEntry {
  number: number;
  name: string;
  file: string;
  status: "completed" | "in-progress" | "pending";
  tokenBudget?: number;
  startedAt?: string;
  endedAt?: string;
  costUsd?: number;
}

export type ProjectStatus = "active" | "paused" | "archived";

export interface PortMapping {
  service: string;
  host: number;
  container: number;
}

export interface DatabaseInfo {
  type: string;
  host: string;
  port: number;
  name: string;
  /** Managed-DB provider inferred from the connection host (e.g. "Neon",
   *  "PlanetScale", "Supabase"); undefined for self-hosted/unknown hosts. */
  provider?: string;
}

export interface GitInfo {
  branch: string;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  isDirty: boolean;
  uncommittedCount: number;
  /** True when the git dirty-status check itself failed (index.lock, timeout,
   *  git missing) rather than succeeding with a clean tree — so the UI can show
   *  "status unavailable" instead of rendering a failure as a clean repo (B5). */
  unknown?: boolean;
  remoteUrl?: string;
}

export interface ClaudeInfo {
  lastSessionDate?: string;
  lastPromptPreview?: string;
  sessionCount: number;
  claudeMdSummary?: string;
  mostRecentSessionStatus?: SessionStatus;
  mostRecentSessionId?: string;
}

export interface WorktreeOverlay {
  branch: string;           // e.g. "feature/gitwc"
  worktreePath: string;     // full path to worktree directory
  todos?: TodoInfo;
  manualSteps?: ManualStepsInfo;
  insights?: InsightsInfo;
}

export interface WorktreeStatus {
  worktreePath: string;
  branch: string;
  isDirty: boolean;
  uncommittedCount: number;
  isMergedLocally: boolean;       // git branch --merged main
  isRemoteBranchDeleted: boolean; // git ls-remote --heads origin <branch> returned empty
  isStale: boolean;               // isMergedLocally && isRemoteBranchDeleted
  lastCommitDate?: string;        // from git log -1 --format=%aI
}

export interface PortConflict {
  port: number;
  projects: string[];
  type: "dev" | "db" | "docker";
}

export interface ScanResult {
  projects: ProjectData[];
  portConflicts: PortConflict[];
  hiddenCount: number;
  scannedAt: string;
  /** Findings from the one-shot global catalog lint (user + plugin-scope entries). */
  catalogLintFindings: LintFinding[];
}
