import type { LintFinding } from "../../types";
import type { SkillEntry } from "../../indexer/types";
import { groupByKey } from "./_shared";

export function runSkillRules(entries: SkillEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  findings.push(...missingDescription(entries));
  findings.push(...longDescription(entries));
  return findings;
}

/**
 * Cross-scope duplicate-name rule — call with the FULL catalog across all
 * scopes (user + plugin + project) so collisions are detected globally.
 */
export function runSkillDuplicateNames(entries: SkillEntry[]): LintFinding[] {
  return duplicateNames(entries);
}

function missingDescription(entries: SkillEntry[]): LintFinding[] {
  return entries
    .filter((e) => !e.description)
    .map((e) => ({
      target: "skill" as const,
      code: "skill/missing-description",
      severity: "P1" as const,
      title: `Skill "${e.name}" has no description — Claude cannot auto-match it`,
      fix: 'Add a `description:` line to the skill frontmatter explaining when Claude should invoke it.',
      penalty: 5,
      engine: "vendored" as const,
      file: e.filePath,
    }));
}

function longDescription(entries: SkillEntry[]): LintFinding[] {
  return entries
    .filter((e) => e.description && e.description.length > 1024)
    .map((e) => ({
      target: "skill" as const,
      code: "skill/long-description",
      severity: "P2" as const,
      title: `Skill "${e.name}" description exceeds 1024 chars — auto-match heuristic may truncate`,
      fix: "Shorten the `description:` value to under 1024 characters.",
      penalty: 2,
      engine: "vendored" as const,
      file: e.filePath,
    }));
}

function duplicateNames(entries: SkillEntry[]): LintFinding[] {
  const byName = groupByKey(entries, (e) => e.name);
  const findings: LintFinding[] = [];
  for (const [name, dupes] of byName) {
    if (dupes.length < 2) continue;
    const scopes = [...new Set(dupes.map((d) => d.source))].join(", ");
    findings.push({
      target: "skill",
      code: "skill/duplicate-name",
      severity: "P1",
      title: `Skill name "${name}" is defined in multiple scopes (${scopes})`,
      fix: "Rename one of the skills or remove the duplicate — last-scope wins and may silently shadow the other.",
      penalty: 5,
      engine: "vendored",
      file: dupes[0].filePath,
    });
  }
  return findings;
}
