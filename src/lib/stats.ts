import { ProjectData, StatsData, ClaudeUsageStats } from "./types";

function countField(
  projects: ProjectData[],
  getter: (p: ProjectData) => string | undefined
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of projects) {
    const val = getter(p);
    if (val) counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

function computeActivity(projects: ProjectData[]) {
  const now = Date.now();
  const DAY = 86400_000;
  const result = { today: 0, thisWeek: 0, thisMonth: 0, older: 0, none: 0 };

  for (const p of projects) {
    if (!p.lastActivity) {
      result.none++;
      continue;
    }
    const age = now - new Date(p.lastActivity).getTime();
    if (age < DAY) result.today++;
    else if (age < 7 * DAY) result.thisWeek++;
    else if (age < 30 * DAY) result.thisMonth++;
    else result.older++;
  }

  return result;
}

export function computeStats(
  projects: ProjectData[],
  hiddenCount: number,
  claudeUsage?: ClaudeUsageStats
): StatsData {
  // Service counts — flatten across all projects
  const services: Record<string, number> = {};
  for (const p of projects) {
    for (const s of p.externalServices) {
      services[s] = (services[s] || 0) + 1;
    }
  }

  // Database types from database info
  const databases: Record<string, number> = {};
  for (const p of projects) {
    if (p.database?.type) {
      databases[p.database.type] = (databases[p.database.type] || 0) + 1;
    }
  }

  // TODO health
  let todoTotal = 0, todoCompleted = 0, todoPending = 0;
  for (const p of projects) {
    if (p.todos) {
      todoTotal += p.todos.total;
      todoCompleted += p.todos.completed;
      todoPending += p.todos.pending;
    }
  }

  // Manual steps health
  let msTotal = 0, msCompleted = 0, msPending = 0;
  for (const p of projects) {
    if (p.manualSteps) {
      msTotal += p.manualSteps.totalSteps;
      msCompleted += p.manualSteps.completedSteps;
      msPending += p.manualSteps.pendingSteps;
    }
  }

  // Claude sessions
  let totalSessions = 0;
  let projectsWithSessions = 0;
  for (const p of projects) {
    if (p.claude && p.claude.sessionCount > 0) {
      totalSessions += p.claude.sessionCount;
      projectsWithSessions++;
    }
  }

  return {
    projectCount: projects.length,
    hiddenCount,
    frameworks: countField(projects, (p) => p.framework),
    orms: countField(projects, (p) => p.orm),
    styling: countField(projects, (p) => p.styling),
    services,
    databases,
    statuses: countField(projects, (p) => p.status),
    activity: computeActivity(projects),
    todoHealth: { total: todoTotal, completed: todoCompleted, pending: todoPending },
    manualStepsHealth: { total: msTotal, completed: msCompleted, pending: msPending },
    claudeSessions: { total: totalSessions, projectsWithSessions },
    claudeUsage,
  };
}
