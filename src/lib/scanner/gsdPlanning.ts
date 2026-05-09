import { promises as fs } from "fs";
import path from "path";
import yaml from "js-yaml";
import type { GsdPlanningInfo, GsdPhaseEntry } from "../types";

/**
 * Scan a project's `.planning/` directory (produced by the GSD skill family)
 * and return structured planning metadata.
 *
 * Returns undefined when `.planning/` is absent (the gate signal — most
 * projects don't use GSD). Never throws; parse failures degrade gracefully.
 *
 * Phase cost windows come ONLY from explicit `startedAt`/`endedAt` in
 * STATE.md YAML. File mtimes are not used — a `git checkout` rewrites them
 * and would attribute random session costs to phases.
 */
export async function scanGsdPlanning(
  projectPath: string,
): Promise<GsdPlanningInfo | undefined> {
  const planningDir = path.join(projectPath, ".planning");
  try {
    const stat = await fs.stat(planningDir);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const [projectInfo, roadmapInfo, stateInfo, rawPhases] = await Promise.all([
    readProjectMd(planningDir),
    readRoadmapMd(planningDir),
    readStateMd(planningDir),
    readPhases(planningDir),
  ]);

  const phases = applyStateOverrides(rawPhases, stateInfo);

  // Compute completion: prefer STATE.md phase statuses (in phases array),
  // fall back to ROADMAP.md checkbox count.
  let completedPhases: number;
  let totalPhases: number;

  if (phases.length > 0) {
    totalPhases = phases.length;
    completedPhases = phases.filter((p) => p.status === "completed").length;
  } else {
    completedPhases = roadmapInfo.completed;
    totalPhases = roadmapInfo.total;
  }

  if (totalPhases === 0) return undefined;

  return {
    projectName: projectInfo.name ?? stateInfo.projectName,
    description: projectInfo.description ?? stateInfo.description,
    status: stateInfo.status,
    milestone: stateInfo.milestone,
    completedPhases,
    totalPhases,
    stoppedAt: stateInfo.stoppedAt,
    phases,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readProjectMd(
  dir: string,
): Promise<{ name?: string; description?: string }> {
  try {
    const raw = await fs.readFile(path.join(dir, "PROJECT.md"), "utf-8");
    const lines = raw.split("\n");
    const headingLine = lines.find((l) => l.startsWith("# "));
    const name = headingLine?.slice(2).trim();
    // First non-empty non-heading paragraph
    let description: string | undefined;
    let pastHeading = false;
    for (const line of lines) {
      if (line.startsWith("# ")) { pastHeading = true; continue; }
      if (pastHeading && line.trim()) { description = line.trim(); break; }
    }
    return { name, description };
  } catch {
    return {};
  }
}

async function readRoadmapMd(dir: string): Promise<{ completed: number; total: number }> {
  try {
    const raw = await fs.readFile(path.join(dir, "ROADMAP.md"), "utf-8");
    const lines = raw.split("\n");
    const completed = lines.filter((l) => /^- \[x\]/i.test(l.trim())).length;
    const pending = lines.filter((l) => /^- \[ \]/.test(l.trim())).length;
    return { completed, total: completed + pending };
  } catch {
    return { completed: 0, total: 0 };
  }
}

interface StateInfo {
  projectName?: string;
  description?: string;
  status?: string;
  milestone?: string;
  stoppedAt?: string;
  /** Per-phase timing from STATE.md YAML. Keyed by phase number (1-indexed). */
  phaseTiming: Map<number, { startedAt?: string; endedAt?: string }>;
  /** Status per phase number from STATE.md. */
  phaseStatuses: Map<number, GsdPhaseEntry["status"]>;
}

async function readStateMd(dir: string): Promise<StateInfo> {
  const empty: StateInfo = { phaseTiming: new Map(), phaseStatuses: new Map() };
  try {
    const raw = await fs.readFile(path.join(dir, "STATE.md"), "utf-8");
    // Extract YAML frontmatter between --- delimiters
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return empty;
    let doc: Record<string, unknown>;
    try {
      doc = (yaml.load(fmMatch[1]) as Record<string, unknown>) ?? {};
    } catch {
      return empty;
    }

    const phaseTiming = new Map<number, { startedAt?: string; endedAt?: string }>();
    const phaseStatuses = new Map<number, GsdPhaseEntry["status"]>();

    // STATE.md may have a `phases` array like:
    // phases:
    //   - number: 1
    //     status: completed
    //     startedAt: "2026-01-01T00:00:00Z"
    //     endedAt: "2026-01-02T00:00:00Z"
    const phasesRaw = doc.phases;
    if (Array.isArray(phasesRaw)) {
      for (const p of phasesRaw) {
        if (!p || typeof p !== "object") continue;
        const ph = p as Record<string, unknown>;
        const num = typeof ph.number === "number" ? ph.number : undefined;
        if (!num) continue;
        const startedAt = typeof ph.startedAt === "string" ? ph.startedAt : undefined;
        const endedAt = typeof ph.endedAt === "string" ? ph.endedAt : undefined;
        phaseTiming.set(num, { startedAt, endedAt });
        const status = normalizePhaseStatus(ph.status);
        if (status) phaseStatuses.set(num, status);
      }
    }

    return {
      projectName: typeof doc.projectName === "string" ? doc.projectName : undefined,
      description: typeof doc.description === "string" ? doc.description : undefined,
      status: typeof doc.status === "string" ? doc.status : undefined,
      milestone: typeof doc.milestone === "string" ? doc.milestone : undefined,
      stoppedAt: typeof doc.stoppedAt === "string" ? doc.stoppedAt : undefined,
      phaseTiming,
      phaseStatuses,
    };
  } catch {
    return empty;
  }
}

async function readPhases(dir: string): Promise<GsdPhaseEntry[]> {
  const phasesDir = path.join(dir, "phases");
  let files: string[];
  try {
    files = await fs.readdir(phasesDir);
  } catch {
    return [];
  }

  const phaseFiles = files
    .filter((f) => /^\d+-.+\.md$/i.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const entries = await Promise.all(
    phaseFiles.map(async (file): Promise<GsdPhaseEntry | null> => {
      const num = parseInt(file, 10);
      try {
        const raw = await fs.readFile(path.join(phasesDir, file), "utf-8");
        const lines = raw.split("\n");
        const heading = lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? file;
        const tokenLine = lines.find((l) => /token budget:/i.test(l));
        const tokenBudget = tokenLine
          ? parseInt(tokenLine.replace(/.*token budget:\s*/i, ""), 10) || undefined
          : undefined;
        return {
          number: num,
          name: heading,
          file,
          status: "pending", // default; overridden by applyStateOverrides in parent
          tokenBudget: isFinite(tokenBudget ?? NaN) ? tokenBudget : undefined,
        };
      } catch {
        return null; // unreadable phase file — skip
      }
    }),
  );
  return entries.filter((e): e is GsdPhaseEntry => e !== null);
}

function normalizePhaseStatus(raw: unknown): GsdPhaseEntry["status"] | undefined {
  if (raw === "completed") return "completed";
  if (raw === "in-progress" || raw === "in_progress" || raw === "active") return "in-progress";
  if (raw === "pending" || raw === "todo") return "pending";
  return undefined;
}

/** Apply STATE.md timing and status overrides to phases extracted from phase files. */
export function applyStateOverrides(
  phases: GsdPhaseEntry[],
  stateInfo: Pick<StateInfo, "phaseTiming" | "phaseStatuses">,
): GsdPhaseEntry[] {
  return phases.map((phase) => {
    const timing = stateInfo.phaseTiming.get(phase.number);
    const status = stateInfo.phaseStatuses.get(phase.number) ?? phase.status;
    return {
      ...phase,
      status,
      startedAt: timing?.startedAt,
      endedAt: timing?.endedAt,
    };
  });
}
