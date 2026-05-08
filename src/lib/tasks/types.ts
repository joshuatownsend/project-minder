export type TaskStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type TaskQuadrant = "do" | "schedule" | "delegate" | "archive" | "delegated-todo";
export type ExecutionMode = "classic" | "stream";
export type RiskLevel = "low" | "medium" | "high";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "awaiting_approval",
  "running",
  "done",
  "failed",
  "cancelled",
];
export const TASK_QUADRANTS: readonly TaskQuadrant[] = ["do", "schedule", "delegate", "archive", "delegated-todo"];
export const EXECUTION_MODES: readonly ExecutionMode[] = ["classic", "stream"];
export const EXECUTION_MODE_LABELS: Record<ExecutionMode, string> = {
  classic: "Classic (text)",
  stream: "Stream (JSON)",
};
export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

/**
 * Legal status transitions. The dispatcher drives:
 *   pending → running
 *   pending → awaiting_approval  (when requires_approval=1)
 *   awaiting_approval → pending  (via approve endpoint, Wave 9.1b)
 *   running → done | failed | cancelled
 *
 * Via API (client-initiated):
 *   pending → cancelled
 *   awaiting_approval → cancelled
 *   failed → pending  (via rerun, Wave 9.1b)
 *
 * The transition table drives the PATCH validation guard.
 */
export const LEGAL_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending:            ["awaiting_approval", "running", "cancelled"],
  awaiting_approval:  ["pending", "cancelled"],
  running:            ["done", "failed", "cancelled"],
  done:               [],
  failed:             ["pending"],
  cancelled:          [],
};

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  quadrant: TaskQuadrant;
  assigned_skill: string | null;
  model: string | null;
  execution_mode: ExecutionMode;
  scheduled_for: string | null;
  requires_approval: number;
  risk_level: RiskLevel;
  dry_run: number;
  schedule_id: number | null;
  approved_at: string | null;
  session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  output_summary: string | null;
  error_message: string | null;
  consecutive_failures: number;
  created_at: string;
  /** JSON blob set by todoDelegation for auto-toggle on completion. */
  metadata: string | null;
}

export type DecisionKind = "decision" | "inbox";

export interface TaskDecision {
  id: number;
  task_id: number;
  session_id: string | null;
  kind: DecisionKind;
  prompt: string;
  /** JSON array string of choices, or null. */
  choices: string | null;
  decision_text: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface Schedule {
  id: number;
  name: string;
  cron_expression: string;
  task_title: string;
  task_description: string;
  assigned_skill: string | null;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: number;
  quadrant?: TaskQuadrant;
  assigned_skill?: string;
  model?: string;
  execution_mode?: ExecutionMode;
  scheduled_for?: string;
  requires_approval?: boolean;
  risk_level?: RiskLevel;
  dry_run?: boolean;
  /** Arbitrary JSON metadata (e.g. todoDelegation source info). */
  metadata?: unknown;
}

export interface PatchTaskInput {
  title?: string;
  description?: string;
  priority?: number;
  quadrant?: TaskQuadrant;
  assigned_skill?: string | null;
  model?: string | null;
  execution_mode?: ExecutionMode;
  scheduled_for?: string | null;
  requires_approval?: boolean;
  risk_level?: RiskLevel;
  dry_run?: boolean;
  status?: TaskStatus;
}

export interface CreateScheduleInput {
  name: string;
  cron_expression: string;
  task_title: string;
  task_description?: string;
  assigned_skill?: string;
  enabled?: boolean;
}

export interface PatchScheduleInput {
  name?: string;
  cron_expression?: string;
  task_title?: string;
  task_description?: string;
  assigned_skill?: string | null;
  enabled?: boolean;
}

export interface TaskListFilter {
  status?: TaskStatus;
  quadrant?: TaskQuadrant;
  /** Filter to only delegated-todo tasks (quadrant = "delegated-todo"). */
  source?: "todo";
}
