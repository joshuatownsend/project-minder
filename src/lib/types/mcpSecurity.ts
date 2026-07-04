// ─── MCP security scanner types ─────────────────────────────────────────────

export type McpFindingSeverity = "crit" | "high" | "med" | "low" | "info";
export type McpFindingCategory =
  | "PI" // prompt injection
  | "CH" // credential harvesting
  | "TP" // tool poisoning
  | "CE" // covert exfiltration
  | "DE" // deobfuscation evasion
  | "SF" // shell feature abuse
  | "HK" // hook / keylogger
  | "TS" // dynamic code execution (TypeScript/JS)
  | "CI" // command injection
  | "PE" // path escape / traversal
  | "EP" // exfiltration param
  | "SC" // sandbox circumvention
  | "XR"; // cross-server / lateral movement

export type McpFindingSurface =
  | "command"
  | "args"
  | "url"
  | "env"
  | "name"
  | "tool-desc"
  | "param-name";

export interface McpFinding {
  id?: number;
  runId: number;
  serverId: string;
  scope: "user" | "project";
  projectSlug?: string;
  ruleId: string;
  category: McpFindingCategory;
  severity: McpFindingSeverity;
  surface: McpFindingSurface;
  surfaceRef?: string;
  message: string;
  evidence?: string;
  foundAtMs: number;
}

export interface McpScanRun {
  id?: number;
  startedAtMs: number;
  durationMs: number;
  serversScanned: number;
  findingsCount: number;
  trigger: "scan" | "manual" | "startup";
}

export interface McpToolFingerprint {
  serverId: string;
  toolName: string;
  descriptionHash: string;
  firstSeenMs: number;
  lastSeenMs: number;
}
