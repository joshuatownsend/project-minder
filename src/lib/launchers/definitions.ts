/**
 * Workflow launcher — curated one-click "run this workflow" definitions.
 *
 * Each entry is a pre-written prompt that the launcher chips dispatch as a task
 * (`POST /api/tasks`) scoped to a project. The dispatcher runs it through the
 * usual `claude -p` pipeline; `metadata.projectPath` sets the child's cwd so the
 * workflow acts on the chosen project. Pure data + pure builders — no React, no
 * fetch — so both the UI and the tests import from here.
 */

import type { ExecutionMode, RiskLevel } from "@/lib/tasks/types";

export interface LauncherWorkflow {
  /** Stable id — also used as the dispatched task's `metadata.launcherId`. */
  id: string;
  /** Leading emoji shown on the chip. */
  icon: string;
  /** Short chip label. */
  label: string;
  /** One-line description (chip tooltip / picker subtitle). */
  description: string;
  /** The instruction handed to the agent (becomes the task description/prompt). */
  prompt: string;
  execution_mode?: ExecutionMode;
  risk_level?: RiskLevel;
  /** When true the task lands in `awaiting_approval` instead of running at once. */
  requires_approval?: boolean;
}

/**
 * The curated gallery. Deliberately small and generic — these read as useful on
 * almost any project. Prompts are written to be self-contained (the agent has
 * no chat history) and to state their own blast radius ("do not modify files",
 * "only edit CHANGELOG.md") so a one-click launch stays predictable.
 */
export const LAUNCHER_WORKFLOWS: readonly LauncherWorkflow[] = [
  {
    id: "review-diff",
    icon: "🔍",
    label: "Review diff",
    description: "Read-only review of the uncommitted changes.",
    prompt:
      "Review the current uncommitted git changes in this repository (inspect `git status` and `git diff`) for bugs, security issues, and code-quality problems. Report findings grouped by severity, citing file and line. Do not modify any files.",
    risk_level: "low",
  },
  {
    id: "test-and-fix",
    icon: "🧪",
    label: "Test & fix",
    description: "Run the test suite and fix any failures.",
    prompt:
      "Run this project's test suite. If any tests fail, investigate the root cause, fix the underlying issue (not the test, unless the test is genuinely wrong), and re-run until the suite passes. Summarize what you changed and why.",
    risk_level: "medium",
  },
  {
    id: "typecheck-lint",
    icon: "🩺",
    label: "Typecheck & lint",
    description: "Run the type-checker and linter, fix what they surface.",
    prompt:
      "Run this project's type-checker and linter (discover the exact commands from package.json / project config). Fix any errors or warnings they surface, then re-run both to confirm a clean result. Summarize the fixes.",
    risk_level: "medium",
  },
  {
    id: "update-changelog",
    icon: "📝",
    label: "Update CHANGELOG",
    description: "Add entries for recent commits under [Unreleased].",
    prompt:
      "Review the git commits made since the most recent CHANGELOG entry and add appropriate entries under an `[Unreleased]` section, following the Keep a Changelog format and the project's existing changelog conventions. Only edit CHANGELOG.md.",
    risk_level: "low",
  },
  {
    id: "tidy-todos",
    icon: "🧹",
    label: "Tidy TODO.md",
    description: "Archive completed items per the living-checklist convention.",
    prompt:
      "Review TODO.md in this project. Move any items that are clearly completed or obsolete into TODO.archive.md (append them there with a completion date and a one-line reason), leaving only outstanding work in TODO.md. Do not remove anything you cannot confirm is done — surface the uncertainty instead. Only edit TODO.md and TODO.archive.md.",
    risk_level: "low",
  },
  {
    id: "dependency-audit",
    icon: "📦",
    label: "Dependency audit",
    description: "Report outdated/vulnerable deps (no changes).",
    prompt:
      "Audit this project's dependencies for outdated or vulnerable packages using the project's package manager (e.g. its `outdated` / `audit` commands). Summarize the findings and propose safe upgrades, grouped by risk. Do not modify package manifests or lockfiles.",
    risk_level: "low",
  },
] as const;

/** What a launcher click resolves to before it becomes a POST body. */
export interface LauncherDispatch {
  title: string;
  description: string;
  execution_mode?: ExecutionMode;
  risk_level?: RiskLevel;
  requires_approval?: boolean;
  metadata: {
    projectPath: string;
    /** Marks the row as launcher-originated (distinguishes from composer tasks). */
    source: "workflow-launcher";
    /** `<workflow id>` for curated chips, `skill:<slug>` for skill chips. */
    launcherId: string;
  };
}

/** Build the dispatch payload for a curated workflow against a project. */
export function buildWorkflowDispatch(
  wf: LauncherWorkflow,
  projectPath: string,
): LauncherDispatch {
  return {
    title: wf.label,
    description: wf.prompt,
    execution_mode: wf.execution_mode,
    risk_level: wf.risk_level,
    requires_approval: wf.requires_approval,
    metadata: { projectPath, source: "workflow-launcher", launcherId: wf.id },
  };
}

/** A user-invocable skill surfaced as a chip. */
export interface SkillChip {
  /** Catalog slug (stable id). */
  slug: string;
  /** The `/name` invocation token. */
  name: string;
  description?: string;
}

/**
 * Build the dispatch payload for a skill chip. The prompt is the bare slash
 * invocation — exactly what the developer would type — so the chip runs the
 * skill against the chosen project.
 */
export function buildSkillDispatch(
  skill: SkillChip,
  projectPath: string,
): LauncherDispatch {
  const invocation = `/${skill.name}`;
  return {
    title: invocation,
    description: invocation,
    risk_level: "low",
    metadata: {
      projectPath,
      source: "workflow-launcher",
      launcherId: `skill:${skill.slug}`,
    },
  };
}

/** Max skill chips to surface — keeps the strip from becoming a wall. */
export const MAX_SKILL_CHIPS = 8;

/**
 * Pick which catalog skills become chips: user-invocable, not disabled, sorted
 * by name, capped. Pure so the selection is unit-testable independent of fetch.
 */
export function selectSkillChips(
  rows: Array<{
    entry?: {
      slug?: string;
      name?: string;
      description?: string;
      userInvocable?: boolean;
      disabled?: boolean;
    };
  }>,
  limit: number = MAX_SKILL_CHIPS,
): SkillChip[] {
  return rows
    .map((r) => r.entry)
    .filter(
      (e): e is NonNullable<typeof e> =>
        !!e && e.userInvocable === true && e.disabled !== true && !!e.name && !!e.slug,
    )
    .map((e) => ({ slug: e.slug!, name: e.name!, description: e.description }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}
