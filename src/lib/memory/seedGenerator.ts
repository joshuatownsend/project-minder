import type { ProjectData, SeedCandidate, MemoryType } from "../types";
import { composeMemoryFile } from "./memoryFrontmatter";

// Day 1 Memory Seed Generator. Composes a candidate set of typed memory
// files from data Project Minder already scans -- so a freshly-installed
// Claude Code session can walk into Day 1 already knowing the user's role,
// stack, and active projects. Nothing here writes to disk; the generator
// returns SeedCandidate[] and the /memory/seed UI promotes a subset via
// the existing memoryWriter.

const TOP_PROJECTS_LIMIT = 10;
const PREVIEW_CHARS = 200;

export interface GeneratorInput {
  userClaudeMd: string | null;
  projects: ProjectData[];
  /** Top-level category mix from session JSONLs, e.g. {"Feature Dev": 412, "Refactoring": 88}. */
  sessionCategories: Map<string, number>;
}

export function generateSeedCandidates(input: GeneratorInput): SeedCandidate[] {
  const out: SeedCandidate[] = [];

  const userRole = synthUserRole(input);
  if (userRole) out.push(userRole);

  const workstyle = synthWorkstyle(input);
  if (workstyle) out.push(workstyle);

  const repos = synthReferenceRepos(input);
  if (repos) out.push(repos);

  const env = synthDevEnvironment(input);
  if (env) out.push(env);

  for (const proj of pickTopProjects(input.projects)) {
    out.push(synthProjectSeed(proj));
  }

  return out;
}

function pickTopProjects(projects: ProjectData[]): ProjectData[] {
  // Active projects with a CLAUDE.md first, sorted by most-recent activity.
  // Use `new Date(x).getTime()` instead of string compare: the type declares
  // lastActivity as string, but the in-memory cached scan can hold Date
  // objects (mirrors the defensive pattern in src/lib/scanner/index.ts:273).
  return projects
    .filter((p) => p.status === "active" && p.claudeMdAudit.hasClaudeMd)
    .sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return tb - ta;
    })
    .slice(0, TOP_PROJECTS_LIMIT);
}

function makeCandidate(args: {
  fileName: string;
  type: MemoryType;
  scope: "user" | "per-project";
  bodyText: string;
  name: string;
  description: string;
  provenance: string[];
  targetProjectPath: string | null;
}): SeedCandidate {
  const composed = composeMemoryFile(
    {
      name: args.name,
      description: args.description,
      type: args.type,
      derived_from: args.provenance,
      seeded: true,
    },
    args.bodyText,
  );
  const preview = args.bodyText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_CHARS);
  return {
    fileName: args.fileName,
    type: args.type,
    scope: args.scope,
    body: composed,
    preview,
    provenance: args.provenance,
    targetProjectPath: args.targetProjectPath,
  };
}

function synthUserRole(input: GeneratorInput): SeedCandidate | null {
  if (!input.userClaudeMd) return null;
  // First non-blank paragraph of the global CLAUDE.md often introduces the
  // user. Take that plus any explicit "I am..." sentences. Worst case the
  // user edits the seed before promoting; better-than-nothing > nothing.
  const paragraphs = input.userClaudeMd.split(/\n\n+/).filter((p) => p.trim());
  const intro = paragraphs.slice(0, 3).join("\n\n");
  const body = `Synthesized from your global CLAUDE.md. Verify before relying on any specific claim.

${intro}
`;
  return makeCandidate({
    fileName: "user_role.md",
    type: "user",
    scope: "user",
    bodyText: body,
    name: "user role",
    description: "Who the user is, derived from ~/.claude/CLAUDE.md",
    provenance: ["~/.claude/CLAUDE.md"],
    targetProjectPath: null,
  });
}

function synthWorkstyle(input: GeneratorInput): SeedCandidate | null {
  if (input.sessionCategories.size === 0) return null;
  const total = Array.from(input.sessionCategories.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const ranked = Array.from(input.sessionCategories.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const lines = ranked.map(([cat, n]) => {
    const pct = Math.round((n / total) * 100);
    return `- **${cat}** — ${pct}% (${n} turns)`;
  });
  const body = `Derived from session JSONL replay. Reflects observed turn classification, not stated preferences -- recalibrate if your work shifted recently.

## Top categories

${lines.join("\n")}
`;
  return makeCandidate({
    fileName: "user_workstyle.md",
    type: "user",
    scope: "user",
    bodyText: body,
    name: "user workstyle",
    description: "Observed work-pattern mix from session classification",
    provenance: [
      "~/.claude/projects/*/sessions/*.jsonl (parseAllSessions)",
      "src/lib/usage/classifier.ts",
    ],
    targetProjectPath: null,
  });
}

function synthReferenceRepos(input: GeneratorInput): SeedCandidate | null {
  const active = input.projects.filter((p) => p.status === "active");
  if (active.length === 0) return null;
  const lines = active.map((p) => {
    const fw = p.framework ? `${p.framework}${p.frameworkVersion ? ` ${p.frameworkVersion}` : ""}` : "no framework detected";
    return `- **${p.name}** (\`${p.path}\`) — ${fw}${p.devPort ? `, dev port ${p.devPort}` : ""}`;
  });
  const body = `Active repositories scanned by Project Minder. Stack summary only; open each project's CLAUDE.md for conventions.

${lines.join("\n")}
`;
  return makeCandidate({
    fileName: "reference_repos.md",
    type: "reference",
    scope: "user",
    bodyText: body,
    name: "active repos",
    description: "One-line stack summary for every active scanned repo",
    provenance: ["ProjectData[] (scanAllProjects)"],
    targetProjectPath: null,
  });
}

function synthDevEnvironment(input: GeneratorInput): SeedCandidate | null {
  // Aggregate stack signals across active projects so the seed reflects what
  // the user actually works with, not an assumed default.
  const frameworks = new Map<string, number>();
  const ormCounts = new Map<string, number>();
  const stylingCounts = new Map<string, number>();
  for (const p of input.projects) {
    if (p.status !== "active") continue;
    if (p.framework) frameworks.set(p.framework, (frameworks.get(p.framework) ?? 0) + 1);
    if (p.orm) ormCounts.set(p.orm, (ormCounts.get(p.orm) ?? 0) + 1);
    if (p.styling) stylingCounts.set(p.styling, (stylingCounts.get(p.styling) ?? 0) + 1);
  }
  if (frameworks.size === 0 && ormCounts.size === 0 && stylingCounts.size === 0) {
    return null;
  }
  const topOf = (m: Map<string, number>) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => `${k} (${n})`)
      .join(", ");
  const body = `Dev-environment signals aggregated across active scanned repos. Counts in parens.

- **Platform**: Windows / PowerShell (per global CLAUDE.md)
- **Frameworks**: ${topOf(frameworks) || "—"}
- **ORMs**: ${topOf(ormCounts) || "—"}
- **Styling**: ${topOf(stylingCounts) || "—"}
`;
  return makeCandidate({
    fileName: "reference_dev_environment.md",
    type: "reference",
    scope: "user",
    bodyText: body,
    name: "dev environment",
    description: "Aggregate stack signals across active scanned repos",
    provenance: ["ProjectData[] (scanAllProjects)"],
    targetProjectPath: null,
  });
}

function synthProjectSeed(p: ProjectData): SeedCandidate {
  const stackLine = p.framework
    ? `${p.framework}${p.frameworkVersion ? ` ${p.frameworkVersion}` : ""}`
    : "framework not detected";
  const partsList: string[] = [
    `- **Path**: \`${p.path}\``,
    `- **Stack**: ${stackLine}`,
  ];
  if (p.devPort) partsList.push(`- **Dev port**: ${p.devPort}`);
  if (p.database?.type) partsList.push(`- **Database**: ${p.database.type}`);
  if (p.git?.branch) partsList.push(`- **Default branch**: ${p.git.branch}`);
  if (p.lastActivity) {
    // ISO-stringify defensively -- cached scans may carry Date objects.
    const iso = new Date(p.lastActivity as unknown as string | number | Date).toISOString();
    partsList.push(`- **Last activity**: ${iso}`);
  }
  const body = `Project-scoped seed for ${p.name}. Verify with the project's CLAUDE.md before relying on conventions.

${partsList.join("\n")}
`;
  return makeCandidate({
    fileName: `project_${p.slug}.md`,
    type: "project",
    scope: "per-project",
    bodyText: body,
    name: `project ${p.slug}`,
    description: `Auto-seeded summary of ${p.name}`,
    provenance: [`${p.path}/CLAUDE.md`, `ProjectData(${p.slug})`],
    targetProjectPath: p.path,
  });
}
