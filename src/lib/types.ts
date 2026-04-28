export interface ProjectData {
  slug: string;
  name: string;
  path: string;
  status: ProjectStatus;

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

  // TODOs
  todos?: TodoInfo;

  // Manual Steps
  manualSteps?: ManualStepsInfo;

  // Insights
  insights?: InsightsInfo;

  // Worktree overlays
  worktrees?: WorktreeOverlay[];

  // Claude config (project-local)
  hooks?: HooksInfo;
  mcpServers?: McpServersInfo;

  // CI/CD
  cicd?: CiCdInfo;

  // Timestamps
  lastActivity?: string;
  scannedAt: string;
}

export type ProjectStatus = "active" | "paused" | "archived";

export type SessionStatus = "working" | "needs_attention" | "idle";

export type LiveSessionStatus = "working" | "approval" | "waiting" | "other";

export interface LiveSession {
  sessionId: string;
  projectSlug: string;
  projectName: string;
  worktreeLabel?: string;
  status: LiveSessionStatus;
  mtime: string;
  lastToolName?: string;
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryFile {
  name: string;
  type?: MemoryType;
  description?: string;
  mtime: string;
  size: number;
}

export interface MemoryData {
  indexMd?: string;
  files: MemoryFile[];
}

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
}

export interface GitInfo {
  branch: string;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  isDirty: boolean;
  uncommittedCount: number;
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

export interface TodoInfo {
  total: number;
  completed: number;
  pending: number;
  items: TodoItem[];
}

export interface TodoItem {
  text: string;
  completed: boolean;
  lineNumber?: number;
}

export interface ManualStepEntry {
  date: string;           // "2026-03-17 14:32"
  featureSlug: string;    // "auth"
  title: string;          // "Clerk + Vercel Authentication Setup"
  steps: ManualStep[];
}

export interface ManualStep {
  text: string;           // "Install Clerk package"
  completed: boolean;
  details: string[];      // indented lines beneath the step
  lineNumber: number;     // 1-based line number for write-back
}

export interface ManualStepsInfo {
  entries: ManualStepEntry[];
  totalSteps: number;
  pendingSteps: number;
  completedSteps: number;
}

export interface InsightEntry {
  id: string;              // hash of content for dedup
  content: string;         // the insight text (between markers)
  sessionId: string;       // which conversation it came from
  date: string;            // ISO timestamp from the JSONL entry
  project: string;         // project slug
  projectPath: string;     // full Windows path
}

export interface InsightsInfo {
  entries: InsightEntry[];
  total: number;
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

export interface MinderConfig {
  statuses: Record<string, ProjectStatus>;
  hidden: string[]; // directory names to skip during scan
  portOverrides: Record<string, number>; // slug -> custom dev port
  devRoot: string; // root directory to scan for projects (kept for backward compat; use getDevRoots())
  devRoots?: string[]; // multiple scan roots; if set, takes precedence over devRoot
  scanBatchSize?: number; // projects scanned in parallel per root (default 10)
  defaultSort?: "activity" | "name" | "claude"; // dashboard default sort
  defaultStatusFilter?: "all" | "active" | "paused" | "archived"; // dashboard default filter
  viewMode?: "full" | "compact" | "list"; // dashboard card layout
  pinnedSlugs?: string[]; // slugs pinned to top of all dashboard views
}

export interface ClaudeUsageStats {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalTurns: number;
  toolUsage: Record<string, number>;
  errorCount: number;
  modelsUsed: string[];
  costEstimate: number; // rough USD estimate
  conversationCount: number;
}

export interface StatsData {
  projectCount: number;
  hiddenCount: number;
  frameworks: Record<string, number>;
  orms: Record<string, number>;
  styling: Record<string, number>;
  services: Record<string, number>;
  databases: Record<string, number>;
  statuses: Record<string, number>;
  activity: { today: number; thisWeek: number; thisMonth: number; older: number; none: number };
  todoHealth: { total: number; completed: number; pending: number };
  manualStepsHealth: { total: number; completed: number; pending: number };
  claudeSessions: { total: number; projectsWithSessions: number };
  claudeUsage?: ClaudeUsageStats;
}

export interface SessionRecap {
  content: string;
  timestamp: string;
  slug?: string; // human-readable session nickname, e.g. "dynamic-giggling-quokka"
}

export interface SessionSummary {
  sessionId: string;
  projectPath: string;
  projectSlug: string;
  projectName: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  initialPrompt?: string;
  lastPrompt?: string;
  recaps?: SessionRecap[];
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costEstimate: number;
  toolUsage: Record<string, number>;
  modelsUsed: string[];
  gitBranch?: string;
  subagentCount: number;
  errorCount: number;
  isActive: boolean;
  status: SessionStatus;
  skillsUsed: Record<string, number>; // skill name → invocation count
  oneShotRate?: number;
  searchableText?: string;
}

export interface TimelineEvent {
  type: "user" | "assistant" | "tool_use" | "thinking" | "error";
  timestamp?: string;
  content: string;
  toolName?: string;
  tokenCount?: number;
}

export interface FileOperation {
  path: string;
  operation: string;
  timestamp?: string;
  toolName: string;
}

export interface SubagentInfo {
  agentId: string;
  type: string;
  description: string;
  messageCount: number;
  toolUsage: Record<string, number>;
}

export interface SessionDetail extends SessionSummary {
  timeline: TimelineEvent[];
  fileOperations: FileOperation[];
  subagents: SubagentInfo[];
}

// ─── Claude config: hooks, MCP servers, plugins ──────────────────────────────

export type HookSource = "project" | "local" | "user";

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookEntry {
  /** PreToolUse | PostToolUse | SessionStart | UserPromptSubmit | Stop | etc. */
  event: string;
  /** Tool/event matcher (e.g. "Edit|Write", "Bash"). Optional. */
  matcher?: string;
  commands: HookCommand[];
  source: HookSource;
  /** Absolute file path the entry came from — used for the future template-builder. */
  sourcePath: string;
}

export interface HooksInfo {
  entries: HookEntry[];
}

export type McpTransport = "stdio" | "http" | "sse" | "unknown";
export type McpSource = "project" | "user";

export interface McpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Env variable KEY NAMES only — never values (avoid leaking secrets). */
  envKeys?: string[];
  source: McpSource;
  sourcePath: string;
}

export interface McpServersInfo {
  servers: McpServer[];
}

export interface PluginEntry {
  name: string;
  marketplace: string;
  enabled: boolean;
  blocked: boolean;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  installPath?: string;
  gitCommitSha?: string;
  pluginRepoUrl?: string;
}

export interface PluginsInfo {
  plugins: PluginEntry[];
}

// ─── CI/CD ───────────────────────────────────────────────────────────────────

export interface WorkflowJob {
  id: string;
  name?: string;
  runsOn?: string;
  /** Reusable-workflow reference (`jobs.<id>.uses`). */
  uses?: string;
  /** Deduped `uses:` references from steps (e.g. "actions/checkout@v4"). */
  actionUses: string[];
}

export interface Workflow {
  /** Absolute path to the workflow file. */
  file: string;
  name?: string;
  /** Normalized triggers: push | pull_request | schedule | workflow_dispatch | ... */
  triggers: string[];
  /** Cron expressions from `on.schedule[].cron`. */
  cron: string[];
  jobs: WorkflowJob[];
  /** False if YAML parsing failed; the entry still surfaces by file name. */
  parseOk: boolean;
}

export type HostingPlatform =
  | "vercel"
  | "railway"
  | "fly"
  | "render"
  | "netlify"
  | "heroku"
  | "docker";

export interface HostingTarget {
  platform: HostingPlatform;
  sourcePath: string;
  detail?: Record<string, string | number | boolean | string[]>;
}

export interface VercelCron {
  path: string;
  schedule: string;
  sourcePath: string;
}

export interface DependabotUpdate {
  ecosystem: string;
  directory?: string;
  schedule?: string;
  sourcePath: string;
}

export interface CiCdInfo {
  workflows: Workflow[];
  hosting: HostingTarget[];
  vercelCrons: VercelCron[];
  dependabot: DependabotUpdate[];
}

export interface UserConfig {
  plugins: PluginsInfo;
  hooks: HooksInfo;
  mcpServers: McpServersInfo;
}

/** Catalog kinds surfaced by `/api/claude-config`. "all" returns every section. */
export type ConfigType = "hooks" | "plugins" | "mcp" | "cicd" | "all";

export const CONFIG_TYPES: readonly ConfigType[] = ["hooks", "plugins", "mcp", "cicd", "all"];

export interface ScanResult {
  projects: ProjectData[];
  portConflicts: PortConflict[];
  hiddenCount: number;
  scannedAt: string;
}
