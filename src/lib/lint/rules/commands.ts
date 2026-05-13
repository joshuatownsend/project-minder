import type { LintFinding, CommandEntry } from "../../types";

export function runCommandRules(entries: CommandEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  findings.push(...missingDescription(entries));
  return findings;
}

/**
 * Cross-scope duplicate-slug rule — call with the FULL catalog across all
 * scopes (user + plugin + project) so collisions are detected globally.
 */
export function runCommandDuplicateSlugs(entries: CommandEntry[]): LintFinding[] {
  return duplicateSlugs(entries);
}

function missingDescription(entries: CommandEntry[]): LintFinding[] {
  return entries
    .filter((e) => !e.description)
    .map((e) => ({
      target: "command" as const,
      code: "command/missing-description",
      severity: "P1" as const,
      title: `Command "${e.name}" has no description — Claude Code won't show a tooltip for it`,
      fix: 'Add a `description:` line to the command frontmatter describing what it does.',
      penalty: 5,
      engine: "vendored" as const,
      file: e.filePath,
    }));
}

function duplicateSlugs(entries: CommandEntry[]): LintFinding[] {
  const bySlug = new Map<string, CommandEntry[]>();
  for (const e of entries) {
    const bucket = bySlug.get(e.slug) ?? [];
    bucket.push(e);
    bySlug.set(e.slug, bucket);
  }
  const findings: LintFinding[] = [];
  for (const [slug, dupes] of bySlug) {
    if (dupes.length < 2) continue;
    const scopes = [...new Set(dupes.map((d) => d.source))].join(", ");
    findings.push({
      target: "command",
      code: "command/duplicate-slug",
      severity: "P1",
      title: `Command "/${slug}" is defined in multiple scopes (${scopes})`,
      fix: "Rename one of the commands or remove the duplicate — last-scope wins and may silently shadow the other.",
      penalty: 5,
      engine: "vendored",
      file: dupes[0].filePath,
    });
  }
  return findings;
}
