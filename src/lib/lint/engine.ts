import type { ClaudeMdAuditInfo, LintFinding, LintReport, LintTarget } from "../types";
import { adaptClaudeMdFindings } from "./adapter/claudeMd";
import { dedupeFindings } from "./dedupe";

/** Inputs for the lint engine. Widened one wave at a time as new targets are added. */
export interface LintInputs {
  /** Wave A: CLAUDE.md adapter only. */
  claudeMdAudit: ClaudeMdAuditInfo;
  // Wave B+: skills, agents, commands (catalog entries)
  // Wave C+: settings, hooks, mcpServers, plugins
  // Wave D+: outputStyles, lspConfig
}

/**
 * Run all lint passes and assemble a `LintReport`.
 *
 * Three passes run in parallel where independent, deduped by
 * (target, file, rule-family). Engine priority: library > vendored > adapter.
 *
 * Wave A ships the adapter pass only; library + vendored stubs return [].
 */
export async function runLintEngine(inputs: LintInputs): Promise<LintReport> {
  const engineErrors: LintReport["engineErrors"] = [];

  const [adapterFindings, libraryFindings, vendoredFindings] = await Promise.all([
    Promise.resolve(adaptClaudeMdFindings(inputs.claudeMdAudit)),
    runLibraryPass(engineErrors),
    runVendoredPass(engineErrors),
  ]);

  const findings = dedupeFindings([adapterFindings, libraryFindings, vendoredFindings]);
  return buildReport(findings, engineErrors);
}

/**
 * Wave B: import `claude-code-lint`'s ClaudeLint class and run it against
 * the project path. Any thrown error is captured in `engineErrors` so the
 * panel degrades gracefully rather than crashing the scan.
 */
async function runLibraryPass(
  _engineErrors: LintReport["engineErrors"],
): Promise<LintFinding[]> {
  // TODO Wave B: const { ClaudeLint } = await import("claude-code-lint");
  return [];
}

/** Wave B+: per-target vendored rule modules (skills, agents, commands, …). */
async function runVendoredPass(
  _engineErrors: LintReport["engineErrors"],
): Promise<LintFinding[]> {
  // TODO Wave B: wire rules/skills.ts, rules/agents.ts, rules/commands.ts
  return [];
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
