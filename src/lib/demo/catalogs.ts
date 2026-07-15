import type { AgentRow } from "@/lib/server/queries/agents";
import type { SkillRow } from "@/lib/server/queries/skills";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";
import type { AgentStats, SkillStats } from "@/lib/usage/types";

/**
 * Synthetic agent + skill catalog fixtures for demo mode — the `data` field of
 * `loadAgentsResponse` / `loadSkillsResponse` (an `AgentRow[]` / `SkillRow[]`,
 * each a catalog entry joined with usage stats). Deterministic (no randomness)
 * and anchored to a `nowMs` passed at request time so relative times stay fresh
 * while the structure is byte-stable. Returned from a guard atop the two query
 * loaders so `/agents`, `/skills`, and their per-project tabs light up without a
 * real `~/.claude` catalog.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO timestamp `offsetMs` in the past relative to `nowMs`. */
function iso(nowMs: number, offsetMs: number): string {
  return new Date(nowMs - offsetMs).toISOString();
}

// ── Agents ──────────────────────────────────────────────────────────────────

interface AgentSeed {
  name: string;
  description: string;
  source: "user" | "plugin" | "project";
  pluginName?: string; // required when source === "plugin"
  marketplace?: string; // required when source === "plugin"
  projectSlug?: string; // required when source === "project"
  model?: string;
  tools?: string[];
  color?: string;
  emoji?: string;
  fileBytes: number;
  // usage
  invocations: number;
  projects: Record<string, number>;
  firstOffset: number;
  lastOffset: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

const AGENT_SEEDS: AgentSeed[] = [
  {
    name: "code-reviewer",
    description:
      "Reviews a diff for correctness bugs, security issues, and convention drift, reporting only high-confidence findings.",
    source: "plugin",
    pluginName: "pr-review-toolkit",
    marketplace: "anthropics/claude-plugins-official",
    model: "opus",
    tools: ["Read", "Grep", "Glob", "Bash"],
    color: "amber",
    emoji: "🔍",
    fileBytes: 6_200,
    invocations: 48,
    projects: { "dev-aurora-commerce": 22, "dev-ledger-api": 14, "dev-quill-cms": 12 },
    firstOffset: 40 * DAY,
    lastOffset: 3 * HOUR,
    costUsd: 4.12,
    inputTokens: 1_840_000,
    outputTokens: 96_000,
  },
  {
    name: "code-explorer",
    description:
      "Traces execution paths and maps architecture across a codebase to brief other agents before they make changes.",
    source: "plugin",
    pluginName: "feature-dev",
    marketplace: "anthropics/claude-plugins-official",
    model: "sonnet",
    tools: ["Glob", "Grep", "Read"],
    color: "blue",
    emoji: "🧭",
    fileBytes: 5_400,
    invocations: 31,
    projects: { "dev-aurora-commerce": 15, "dev-pulse-analytics": 9, "dev-beacon-mobile": 7 },
    firstOffset: 28 * DAY,
    lastOffset: 6 * HOUR,
    costUsd: 2.03,
    inputTokens: 980_000,
    outputTokens: 41_000,
  },
  {
    name: "test-writer",
    description:
      "Generates focused unit and integration tests for changed modules, mirroring the project's existing test conventions.",
    source: "user",
    model: "sonnet",
    tools: ["Read", "Write", "Edit", "Bash"],
    color: "green",
    emoji: "🧪",
    fileBytes: 4_100,
    invocations: 26,
    projects: { "dev-ledger-api": 12, "dev-aurora-commerce": 9, "dev-quill-cms": 5 },
    firstOffset: 22 * DAY,
    lastOffset: 20 * HOUR,
    costUsd: 1.44,
    inputTokens: 620_000,
    outputTokens: 58_000,
  },
  {
    name: "doc-updater",
    description:
      "Keeps README, help docs, and changelog entries in sync after a feature lands, following the repo's documentation policy.",
    source: "user",
    model: "haiku",
    tools: ["Read", "Edit", "Grep"],
    color: "purple",
    emoji: "📝",
    fileBytes: 3_300,
    invocations: 14,
    projects: { "dev-aurora-commerce": 8, "dev-pulse-analytics": 6 },
    firstOffset: 18 * DAY,
    lastOffset: 2 * DAY,
    costUsd: 0.21,
    inputTokens: 210_000,
    outputTokens: 19_000,
  },
  {
    name: "security-auditor",
    description:
      "Audits payment and auth flows for injection, secret leakage, and unsafe fallbacks; project-scoped to the commerce app.",
    source: "project",
    projectSlug: "aurora-commerce",
    model: "opus",
    tools: ["Read", "Grep", "Glob", "Bash"],
    color: "red",
    emoji: "🛡️",
    fileBytes: 7_800,
    invocations: 11,
    projects: { "dev-aurora-commerce": 11 },
    firstOffset: 12 * DAY,
    lastOffset: 26 * HOUR,
    costUsd: 1.87,
    inputTokens: 540_000,
    outputTokens: 22_000,
  },
  {
    name: "refactorer",
    description:
      "Simplifies recently-changed code for clarity and reuse while preserving behavior; leans on typecheck and tests to verify.",
    source: "user",
    model: "sonnet",
    tools: ["Read", "Edit", "Bash"],
    color: "cyan",
    emoji: "♻️",
    fileBytes: 4_600,
    invocations: 19,
    projects: { "dev-quill-cms": 8, "dev-beacon-mobile": 6, "dev-ledger-api": 5 },
    firstOffset: 15 * DAY,
    lastOffset: 9 * HOUR,
    costUsd: 0.98,
    inputTokens: 430_000,
    outputTokens: 37_000,
  },
];

function agentProvenance(seed: AgentSeed): AgentEntry["provenance"] {
  if (seed.source === "plugin") {
    return {
      kind: "marketplace-plugin",
      pluginName: seed.pluginName ?? "unknown-plugin",
      marketplace: seed.marketplace ?? "anthropics/claude-plugins-official",
      marketplaceRepo: seed.marketplace,
      pluginVersion: "1.4.0",
    };
  }
  if (seed.source === "project") {
    return { kind: "project-local", projectSlug: seed.projectSlug ?? "unknown" };
  }
  return { kind: "user-local" };
}

function agentFilePath(seed: AgentSeed): string {
  if (seed.source === "plugin") {
    return `C:\\Users\\demo\\.claude\\plugins\\${seed.pluginName}\\agents\\${seed.name}.md`;
  }
  if (seed.source === "project") {
    return `C:\\dev\\${seed.projectSlug}\\.claude\\agents\\${seed.name}.md`;
  }
  return `C:\\Users\\demo\\.claude\\agents\\${seed.name}.md`;
}

function buildAgentEntry(seed: AgentSeed, nowMs: number): AgentEntry {
  return {
    kind: "agent",
    id: `agent:${seed.source}:${seed.name}`,
    slug: seed.name,
    name: seed.name,
    description: seed.description,
    source: seed.source,
    pluginName: seed.source === "plugin" ? seed.pluginName : undefined,
    projectSlug: seed.source === "project" ? seed.projectSlug : undefined,
    category: "workflow",
    filePath: agentFilePath(seed),
    bodyExcerpt: seed.description,
    frontmatter: {
      name: seed.name,
      description: seed.description,
      ...(seed.model ? { model: seed.model } : {}),
      ...(seed.tools ? { tools: seed.tools.join(", ") } : {}),
    },
    mtime: iso(nowMs, seed.lastOffset),
    ctime: iso(nowMs, seed.firstOffset),
    provenance: agentProvenance(seed),
    fileBytes: seed.fileBytes,
    projectedContextCost: {
      tokenEstimate: Math.round(seed.fileBytes / 4),
      contextWindowPercent: Number(((seed.fileBytes / 4 / 200_000) * 100).toFixed(2)),
    },
    model: seed.model,
    tools: seed.tools,
    color: seed.color,
    emoji: seed.emoji,
  };
}

function buildAgentStats(seed: AgentSeed, nowMs: number): AgentStats {
  return {
    name: seed.name,
    invocations: seed.invocations,
    firstUsed: iso(nowMs, seed.firstOffset),
    lastUsed: iso(nowMs, seed.lastOffset),
    projects: seed.projects,
    sessions: Array.from(
      { length: Math.min(4, seed.invocations) },
      (_, i) => `demo-sess-${seed.name}-${i}`,
    ),
    costUsd: seed.costUsd,
    inputTokens: seed.inputTokens,
    outputTokens: seed.outputTokens,
  };
}

/** Demo agent catalog — the `data` field of `loadAgentsResponse`. */
export function demoAgents(nowMs: number): AgentRow[] {
  return AGENT_SEEDS.map((seed) => ({
    entry: buildAgentEntry(seed, nowMs),
    usage: buildAgentStats(seed, nowMs),
  }));
}

// ── Skills ──────────────────────────────────────────────────────────────────

interface SkillSeed {
  name: string;
  description: string;
  source: "user" | "plugin" | "project";
  pluginName?: string;
  marketplace?: string;
  projectSlug?: string;
  layout: "bundled" | "standalone";
  userInvocable?: boolean;
  argumentHint?: string;
  fileBytes: number;
  invocations: number;
  projects: Record<string, number>;
  firstOffset: number;
  lastOffset: number;
  slashCount?: number;
  autoCount?: number;
}

const SKILL_SEEDS: SkillSeed[] = [
  {
    name: "gsd-planning",
    description:
      "Turns a vague goal into a sequenced implementation plan with critical files, trade-offs, and a build order.",
    source: "plugin",
    pluginName: "feature-dev",
    marketplace: "anthropics/claude-plugins-official",
    layout: "bundled",
    userInvocable: true,
    argumentHint: "<goal or feature description>",
    fileBytes: 8_900,
    invocations: 37,
    projects: { "dev-aurora-commerce": 18, "dev-pulse-analytics": 11, "dev-ledger-api": 8 },
    firstOffset: 35 * DAY,
    lastOffset: 4 * HOUR,
    slashCount: 29,
    autoCount: 8,
  },
  {
    name: "changelog",
    description:
      "Appends a Keep a Changelog entry under [Unreleased] for any user-facing, API, or behavior change.",
    source: "user",
    layout: "standalone",
    userInvocable: true,
    argumentHint: "<summary of the change>",
    fileBytes: 2_600,
    invocations: 22,
    projects: { "dev-aurora-commerce": 10, "dev-quill-cms": 7, "dev-beacon-mobile": 5 },
    firstOffset: 26 * DAY,
    lastOffset: 22 * HOUR,
    slashCount: 20,
    autoCount: 2,
  },
  {
    name: "pr-review",
    description:
      "Runs a structured pull-request review pass — correctness, tests, and simplifications — and posts inline findings.",
    source: "plugin",
    pluginName: "pr-review-toolkit",
    marketplace: "anthropics/claude-plugins-official",
    layout: "bundled",
    userInvocable: true,
    argumentHint: "[pr number]",
    fileBytes: 6_400,
    invocations: 16,
    projects: { "dev-aurora-commerce": 9, "dev-ledger-api": 7 },
    firstOffset: 20 * DAY,
    lastOffset: 8 * HOUR,
    slashCount: 15,
    autoCount: 1,
  },
  {
    name: "memory",
    description:
      "Captures a durable cross-session note about a decision, gotcha, or subsystem into project memory.",
    source: "user",
    layout: "standalone",
    userInvocable: true,
    fileBytes: 1_900,
    invocations: 13,
    projects: { "dev-pulse-analytics": 6, "dev-aurora-commerce": 4, "dev-synth-playground": 3 },
    firstOffset: 17 * DAY,
    lastOffset: 30 * HOUR,
    slashCount: 4,
    autoCount: 9,
  },
  {
    name: "artifact-design",
    description:
      "Calibrates how much visual-design investment an artifact warrants before writing the page.",
    source: "user",
    layout: "bundled",
    userInvocable: false,
    fileBytes: 5_100,
    invocations: 8,
    projects: { "dev-synth-playground": 5, "dev-pulse-analytics": 3 },
    firstOffset: 11 * DAY,
    lastOffset: 2 * DAY,
    slashCount: 0,
    autoCount: 8,
  },
];

function skillProvenance(seed: SkillSeed): SkillEntry["provenance"] {
  if (seed.source === "plugin") {
    return {
      kind: "marketplace-plugin",
      pluginName: seed.pluginName ?? "unknown-plugin",
      marketplace: seed.marketplace ?? "anthropics/claude-plugins-official",
      marketplaceRepo: seed.marketplace,
      pluginVersion: "1.4.0",
    };
  }
  if (seed.source === "project") {
    return { kind: "project-local", projectSlug: seed.projectSlug ?? "unknown" };
  }
  return { kind: "user-local" };
}

function skillFilePath(seed: SkillSeed): string {
  const leaf = seed.layout === "bundled" ? `${seed.name}\\SKILL.md` : `${seed.name}.md`;
  if (seed.source === "plugin") {
    return `C:\\Users\\demo\\.claude\\plugins\\${seed.pluginName}\\skills\\${leaf}`;
  }
  if (seed.source === "project") {
    return `C:\\dev\\${seed.projectSlug}\\.claude\\skills\\${leaf}`;
  }
  return `C:\\Users\\demo\\.claude\\skills\\${leaf}`;
}

function buildSkillEntry(seed: SkillSeed, nowMs: number): SkillEntry {
  return {
    kind: "skill",
    id: `skill:${seed.source}:${seed.name}`,
    slug: seed.name,
    name: seed.name,
    description: seed.description,
    source: seed.source,
    pluginName: seed.source === "plugin" ? seed.pluginName : undefined,
    projectSlug: seed.source === "project" ? seed.projectSlug : undefined,
    filePath: skillFilePath(seed),
    bodyExcerpt: seed.description,
    frontmatter: {
      name: seed.name,
      description: seed.description,
      ...(seed.argumentHint ? { "argument-hint": seed.argumentHint } : {}),
    },
    mtime: iso(nowMs, seed.lastOffset),
    ctime: iso(nowMs, seed.firstOffset),
    provenance: skillProvenance(seed),
    fileBytes: seed.fileBytes,
    projectedContextCost: {
      tokenEstimate: Math.round(seed.fileBytes / 4),
      contextWindowPercent: Number(((seed.fileBytes / 4 / 200_000) * 100).toFixed(2)),
    },
    layout: seed.layout,
    version: "1.0.0",
    userInvocable: seed.userInvocable,
    argumentHint: seed.argumentHint,
  };
}

function buildSkillStats(seed: SkillSeed, nowMs: number): SkillStats {
  return {
    name: seed.name,
    invocations: seed.invocations,
    firstUsed: iso(nowMs, seed.firstOffset),
    lastUsed: iso(nowMs, seed.lastOffset),
    projects: seed.projects,
    sessions: Array.from(
      { length: Math.min(4, seed.invocations) },
      (_, i) => `demo-sess-${seed.name}-${i}`,
    ),
  };
}

/** Demo skill catalog — the `data` field of `loadSkillsResponse`. */
export function demoSkills(nowMs: number): SkillRow[] {
  return SKILL_SEEDS.map((seed) => ({
    entry: buildSkillEntry(seed, nowMs),
    usage: buildSkillStats(seed, nowMs),
    slashCount: seed.slashCount,
    autoCount: seed.autoCount,
  }));
}
