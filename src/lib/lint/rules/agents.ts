import type { LintFinding } from "../../types";
import type { AgentEntry } from "../../indexer/types";

export function runAgentRules(entries: AgentEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  findings.push(...missingDescription(entries));
  findings.push(...longDescription(entries));
  return findings;
}

/**
 * Cross-scope duplicate-name rule — call with the FULL catalog across all
 * scopes (user + plugin + project) so collisions are detected globally.
 */
export function runAgentDuplicateNames(entries: AgentEntry[]): LintFinding[] {
  return duplicateNames(entries);
}

function missingDescription(entries: AgentEntry[]): LintFinding[] {
  return entries
    .filter((e) => !e.description)
    .map((e) => ({
      target: "agent" as const,
      code: "agent/missing-description",
      severity: "P1" as const,
      title: `Agent "${e.name}" has no description — Claude cannot route tasks to it`,
      fix: 'Add a `description:` line to the agent frontmatter explaining the agent\'s purpose.',
      penalty: 5,
      engine: "vendored" as const,
      file: e.filePath,
    }));
}

function longDescription(entries: AgentEntry[]): LintFinding[] {
  return entries
    .filter((e) => e.description && e.description.length > 1024)
    .map((e) => ({
      target: "agent" as const,
      code: "agent/long-description",
      severity: "P2" as const,
      title: `Agent "${e.name}" description exceeds 1024 chars — routing heuristic may truncate`,
      fix: "Shorten the `description:` value to under 1024 characters.",
      penalty: 2,
      engine: "vendored" as const,
      file: e.filePath,
    }));
}

function duplicateNames(entries: AgentEntry[]): LintFinding[] {
  const byName = new Map<string, AgentEntry[]>();
  for (const e of entries) {
    const bucket = byName.get(e.name) ?? [];
    bucket.push(e);
    byName.set(e.name, bucket);
  }
  const findings: LintFinding[] = [];
  for (const [name, dupes] of byName) {
    if (dupes.length < 2) continue;
    const scopes = [...new Set(dupes.map((d) => d.source))].join(", ");
    findings.push({
      target: "agent",
      code: "agent/duplicate-name",
      severity: "P1",
      title: `Agent name "${name}" is defined in multiple scopes (${scopes})`,
      fix: "Rename one of the agents or remove the duplicate — last-scope wins and may silently shadow the other.",
      penalty: 5,
      engine: "vendored",
      file: dupes[0].filePath,
    });
  }
  return findings;
}
