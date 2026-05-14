import type {
  ClaudeMdAuditInfo,
  HookEntry,
  McpServer,
  PluginEntry,
  LintFinding,
  LintReport,
  LintTarget,
  CommandEntry,
} from "../types";
import type { AgentEntry, SkillEntry } from "../indexer/types";
import { adaptClaudeMdFindings } from "./adapter/claudeMd";
import { dedupeFindings } from "./dedupe";
import { runLibraryCli } from "./library";
import { runMcpRules } from "./rules/mcp";
import { runHookRules } from "./rules/hooks";
import { runPluginRules } from "./rules/plugins";
import { runSkillRules, runSkillDuplicateNames } from "./rules/skills";
import { runAgentRules, runAgentDuplicateNames } from "./rules/agents";
import { runCommandRules, runCommandDuplicateSlugs } from "./rules/commands";

/** Inputs for the lint engine. Widened one wave at a time as new targets are added. */
export interface LintInputs {
  /** All waves: CLAUDE.md adapter re-emits findings into unified shape. */
  claudeMdAudit: ClaudeMdAuditInfo;
  /** Wave B+: project directory for library CLI pass. */
  projectPath: string;
  /** Wave B+: all MCP servers across sources for cross-scope vendored rules. */
  mcpServers?: McpServer[];
  /** Wave C+: hook entries from project + user + plugin scopes. */
  hooks?: HookEntry[];
  /** Wave C+: plugin entries from the merged registry. */
  plugins?: PluginEntry[];
  // Wave D+: outputStyles, lspConfig
  /** Wave F+: project-scope catalog entries for structural rules. */
  skills?: SkillEntry[];
  agents?: AgentEntry[];
  commands?: CommandEntry[];
}

/** Inputs for the one-shot global catalog lint that runs once per scan. */
export interface GlobalLintInputs {
  allSkills: SkillEntry[];
  allAgents: AgentEntry[];
  allCommands: CommandEntry[];
  allPlugins: PluginEntry[];
}

/**
 * Run all lint passes and assemble a `LintReport`.
 *
 * Three passes run in parallel where possible, then deduped by
 * (target, file, rule-family). Engine priority: library > vendored > adapter.
 */
export async function runLintEngine(inputs: LintInputs): Promise<LintReport> {
  const engineErrors: LintReport["engineErrors"] = [];

  const [adapterFindings, libraryFindings, vendoredFindings] = await Promise.all([
    Promise.resolve(adaptClaudeMdFindings(inputs.claudeMdAudit)),
    runLibraryPass(inputs.projectPath, engineErrors),
    Promise.resolve(runVendoredPass(inputs)),
  ]);

  const findings = dedupeFindings([adapterFindings, libraryFindings, vendoredFindings]);
  return buildReport(findings, engineErrors);
}

/**
 * Spawn `claude-code-lint check-all --format json` in the project directory.
 * Findings for the CLAUDE.md target are excluded — the adapter handles those.
 * Any CLI error is captured in `engineErrors` so the panel degrades gracefully.
 */
async function runLibraryPass(
  projectPath: string,
  engineErrors: LintReport["engineErrors"],
): Promise<LintFinding[]> {
  const findings = await runLibraryCli(projectPath, engineErrors);
  // Exclude claude-md target — the adapter already surfaces those via the
  // existing audit, and running both would produce duplicate findings.
  return findings.filter((f) => f.target !== "claude-md");
}

/** Vendored rules that use cross-scope data the library CLI cannot access. */
function runVendoredPass(inputs: LintInputs): LintFinding[] {
  const findings: LintFinding[] = [];
  if (inputs.mcpServers) findings.push(...runMcpRules(inputs.mcpServers));
  if (inputs.hooks)      findings.push(...runHookRules(inputs.hooks));
  if (inputs.plugins)    findings.push(...runPluginRules(inputs.plugins));
  // Wave D+: outputStyles, lspConfig
  // Wave F+: project-scope structural rules for catalog targets.
  if (inputs.skills)   findings.push(...runSkillRules(inputs.skills));
  if (inputs.agents)   findings.push(...runAgentRules(inputs.agents));
  if (inputs.commands) findings.push(...runCommandRules(inputs.commands));
  return findings;
}

/**
 * One-shot global lint that runs once per scan.
 * Lints user + plugin scope entries with structural rules; runs cross-scope
 * duplicate-name/slug checks over the full catalog (all scopes).
 */
export function runGlobalLint(inputs: GlobalLintInputs): LintFinding[] {
  const findings: LintFinding[] = [];

  const nonProjectSkills   = inputs.allSkills.filter((e) => e.source !== "project");
  const nonProjectAgents   = inputs.allAgents.filter((e) => e.source !== "project");
  const nonProjectCommands = inputs.allCommands.filter((e) => e.source !== "project");

  findings.push(...runSkillRules(nonProjectSkills));
  findings.push(...runAgentRules(nonProjectAgents));
  findings.push(...runCommandRules(nonProjectCommands));

  // Cross-scope duplicate detection — runs over full catalog.
  findings.push(...runSkillDuplicateNames(inputs.allSkills));
  findings.push(...runAgentDuplicateNames(inputs.allAgents));
  findings.push(...runCommandDuplicateSlugs(inputs.allCommands));

  return dedupeFindings([findings]);
}

function buildReport(
  findings: LintFinding[],
  engineErrors: LintReport["engineErrors"],
): LintReport {
  const totalCounts = { P0: 0, P1: 0, P2: 0 };
  const countsByTarget: Partial<Record<LintTarget, { P0: number; P1: number; P2: number }>> = {};

  for (const f of findings) {
    totalCounts[f.severity]++;
    const tc = countsByTarget[f.target] ?? { P0: 0, P1: 0, P2: 0 };
    tc[f.severity]++;
    countsByTarget[f.target] = tc;
  }

  return { findings, countsByTarget, totalCounts, engineErrors };
}
