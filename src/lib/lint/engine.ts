import type {
  ClaudeMdAuditInfo,
  HookEntry,
  McpServer,
  PluginEntry,
  LintFinding,
  LintReport,
  LintTarget,
} from "../types";
import { adaptClaudeMdFindings } from "./adapter/claudeMd";
import { dedupeFindings } from "./dedupe";
import { runLibraryCli } from "./library";
import { runMcpRules } from "./rules/mcp";
import { runHookRules } from "./rules/hooks";
import { runPluginRules } from "./rules/plugins";

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
  return findings;
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
