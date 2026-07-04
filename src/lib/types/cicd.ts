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
