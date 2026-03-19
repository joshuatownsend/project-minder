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

  // Timestamps
  lastActivity?: string;
  scannedAt: string;
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
}

export interface GitInfo {
  branch: string;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  isDirty: boolean;
  uncommittedCount: number;
}

export interface ClaudeInfo {
  lastSessionDate?: string;
  lastPromptPreview?: string;
  sessionCount: number;
  claudeMdSummary?: string;
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

export interface PortConflict {
  port: number;
  projects: string[];
  type: "dev" | "db" | "docker";
}

export interface MinderConfig {
  statuses: Record<string, ProjectStatus>;
  hidden: string[]; // directory names to skip during scan
  portOverrides: Record<string, number>; // slug -> custom dev port
  devRoot: string; // root directory to scan for projects
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

export interface SessionSummary {
  sessionId: string;
  projectPath: string;
  projectSlug: string;
  projectName: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  initialPrompt?: string;
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
  skillsUsed: Record<string, number>; // skill name → invocation count
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

export interface ScanResult {
  projects: ProjectData[];
  portConflicts: PortConflict[];
  hiddenCount: number;
  scannedAt: string;
}
