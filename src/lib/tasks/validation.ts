import {
  TASK_STATUSES,
  TASK_QUADRANTS,
  EXECUTION_MODES,
  RISK_LEVELS,
  LEGAL_TRANSITIONS,
  type TaskStatus,
  type TaskQuadrant,
  type ExecutionMode,
  type RiskLevel,
  type CreateTaskInput,
  type PatchTaskInput,
  type CreateScheduleInput,
  type PatchScheduleInput,
} from "./types";
import { validateCron } from "./cron";

type ValidationResult = { ok: true } | { ok: false; error: string; field?: string };

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}
function isTaskQuadrant(v: unknown): v is TaskQuadrant {
  return typeof v === "string" && (TASK_QUADRANTS as readonly string[]).includes(v);
}
function isExecutionMode(v: unknown): v is ExecutionMode {
  return typeof v === "string" && (EXECUTION_MODES as readonly string[]).includes(v);
}
function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === "string" && (RISK_LEVELS as readonly string[]).includes(v);
}

export function validateCreateTask(body: unknown): CreateTaskInput | { error: string; field?: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (!b.title || typeof b.title !== "string" || b.title.trim() === "") {
    return { error: "title is required and must be a non-empty string", field: "title" };
  }
  if (b.description !== undefined && typeof b.description !== "string") {
    return { error: "description must be a string", field: "description" };
  }
  if (b.priority !== undefined) {
    const p = Number(b.priority);
    if (!Number.isInteger(p) || p < 1 || p > 5) {
      return { error: "priority must be an integer between 1 and 5", field: "priority" };
    }
  }
  if (b.quadrant !== undefined && !isTaskQuadrant(b.quadrant)) {
    return { error: `quadrant must be one of: ${TASK_QUADRANTS.join(", ")}`, field: "quadrant" };
  }
  if (b.assigned_skill !== undefined && b.assigned_skill !== null && typeof b.assigned_skill !== "string") {
    return { error: "assigned_skill must be a string or null", field: "assigned_skill" };
  }
  if (b.model !== undefined && b.model !== null && typeof b.model !== "string") {
    return { error: "model must be a string or null", field: "model" };
  }
  if (b.execution_mode !== undefined && !isExecutionMode(b.execution_mode)) {
    return { error: `execution_mode must be one of: ${EXECUTION_MODES.join(", ")}`, field: "execution_mode" };
  }
  if (b.scheduled_for !== undefined && b.scheduled_for !== null && typeof b.scheduled_for !== "string") {
    return { error: "scheduled_for must be an ISO 8601 string or null", field: "scheduled_for" };
  }
  if (b.risk_level !== undefined && !isRiskLevel(b.risk_level)) {
    return { error: `risk_level must be one of: ${RISK_LEVELS.join(", ")}`, field: "risk_level" };
  }
  if (b.requires_approval !== undefined && typeof b.requires_approval !== "boolean") {
    return { error: "requires_approval must be a boolean", field: "requires_approval" };
  }
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") {
    return { error: "dry_run must be a boolean", field: "dry_run" };
  }

  return {
    title: (b.title as string).trim(),
    description: typeof b.description === "string" ? b.description : undefined,
    priority: b.priority !== undefined ? Number(b.priority) : undefined,
    quadrant: b.quadrant as TaskQuadrant | undefined,
    assigned_skill: typeof b.assigned_skill === "string" ? b.assigned_skill : undefined,
    model: typeof b.model === "string" ? b.model : undefined,
    execution_mode: b.execution_mode as ExecutionMode | undefined,
    scheduled_for: typeof b.scheduled_for === "string" ? b.scheduled_for : undefined,
    requires_approval: typeof b.requires_approval === "boolean" ? b.requires_approval : undefined,
    risk_level: b.risk_level as RiskLevel | undefined,
    dry_run: typeof b.dry_run === "boolean" ? b.dry_run : undefined,
  };
}

export function validatePatchTask(
  body: unknown,
  currentStatus: TaskStatus
): PatchTaskInput | { error: string; field?: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (b.title !== undefined) {
    if (typeof b.title !== "string" || b.title.trim() === "") {
      return { error: "title must be a non-empty string", field: "title" };
    }
  }
  if (b.description !== undefined && typeof b.description !== "string") {
    return { error: "description must be a string", field: "description" };
  }
  if (b.priority !== undefined) {
    const p = Number(b.priority);
    if (!Number.isInteger(p) || p < 1 || p > 5) {
      return { error: "priority must be an integer between 1 and 5", field: "priority" };
    }
  }
  if (b.quadrant !== undefined && !isTaskQuadrant(b.quadrant)) {
    return { error: `quadrant must be one of: ${TASK_QUADRANTS.join(", ")}`, field: "quadrant" };
  }
  if (b.execution_mode !== undefined && !isExecutionMode(b.execution_mode)) {
    return { error: `execution_mode must be one of: ${EXECUTION_MODES.join(", ")}`, field: "execution_mode" };
  }
  if (b.risk_level !== undefined && !isRiskLevel(b.risk_level)) {
    return { error: `risk_level must be one of: ${RISK_LEVELS.join(", ")}`, field: "risk_level" };
  }
  if (b.requires_approval !== undefined && typeof b.requires_approval !== "boolean") {
    return { error: "requires_approval must be a boolean", field: "requires_approval" };
  }
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") {
    return { error: "dry_run must be a boolean", field: "dry_run" };
  }

  // Status transition guard
  if (b.status !== undefined) {
    if (!isTaskStatus(b.status)) {
      return { error: `status must be one of: ${TASK_STATUSES.join(", ")}`, field: "status" };
    }
    const newStatus = b.status as TaskStatus;
    if (newStatus !== currentStatus) {
      const allowed = LEGAL_TRANSITIONS[currentStatus];
      if (!allowed.includes(newStatus)) {
        return {
          error: `Cannot transition from '${currentStatus}' to '${newStatus}'. Allowed transitions from '${currentStatus}': ${allowed.length > 0 ? allowed.join(", ") : "none"}`,
          field: "status",
        };
      }
    }
  }

  const out: PatchTaskInput = { ...b } as PatchTaskInput;
  if (typeof out.title === "string") out.title = out.title.trim();
  return out;
}

export function validateCreateSchedule(
  body: unknown
): CreateScheduleInput | { error: string; field?: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (!b.name || typeof b.name !== "string" || b.name.trim() === "") {
    return { error: "name is required and must be a non-empty string", field: "name" };
  }
  if (!b.cron_expression || typeof b.cron_expression !== "string") {
    return { error: "cron_expression is required", field: "cron_expression" };
  }
  const cronResult = validateCron(b.cron_expression as string);
  if (!cronResult.ok) {
    return { error: `cron_expression is invalid: ${cronResult.error}`, field: "cron_expression" };
  }
  if (!b.task_title || typeof b.task_title !== "string" || b.task_title.trim() === "") {
    return { error: "task_title is required and must be a non-empty string", field: "task_title" };
  }
  if (b.task_description !== undefined && typeof b.task_description !== "string") {
    return { error: "task_description must be a string", field: "task_description" };
  }
  if (b.assigned_skill !== undefined && b.assigned_skill !== null && typeof b.assigned_skill !== "string") {
    return { error: "assigned_skill must be a string or null", field: "assigned_skill" };
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return { error: "enabled must be a boolean", field: "enabled" };
  }

  return {
    name: (b.name as string).trim(),
    cron_expression: (b.cron_expression as string).trim(),
    task_title: (b.task_title as string).trim(),
    task_description: typeof b.task_description === "string" ? b.task_description : undefined,
    assigned_skill: typeof b.assigned_skill === "string" ? b.assigned_skill : undefined,
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
  };
}

export function validatePatchSchedule(
  body: unknown
): PatchScheduleInput | { error: string; field?: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.trim() === "") {
      return { error: "name must be a non-empty string", field: "name" };
    }
  }
  if (b.cron_expression !== undefined) {
    if (typeof b.cron_expression !== "string") {
      return { error: "cron_expression must be a string", field: "cron_expression" };
    }
    const cronResult = validateCron(b.cron_expression);
    if (!cronResult.ok) {
      return { error: `cron_expression is invalid: ${cronResult.error}`, field: "cron_expression" };
    }
  }
  if (b.task_title !== undefined) {
    if (typeof b.task_title !== "string" || b.task_title.trim() === "") {
      return { error: "task_title must be a non-empty string", field: "task_title" };
    }
  }
  if (b.task_description !== undefined && typeof b.task_description !== "string") {
    return { error: "task_description must be a string", field: "task_description" };
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return { error: "enabled must be a boolean", field: "enabled" };
  }

  return b as PatchScheduleInput;
}

export { isTaskStatus, isTaskQuadrant, isExecutionMode, isRiskLevel };
export type { ValidationResult };
