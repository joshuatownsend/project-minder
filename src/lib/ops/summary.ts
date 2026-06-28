import type { ProjectData, OpsSummary, OpsCron, HostingTarget } from "../types";

/**
 * The slices of ProjectData that `deriveOpsSummary` reads. Taking only these
 * keeps callers/tests from building a whole ProjectData and documents that the
 * derive layer is a pure reshape — it never touches the filesystem.
 */
type OpsInput = Pick<
  ProjectData,
  "cicd" | "externalServices" | "database" | "operations"
>;

/**
 * Compose a single operational shape from fields Minder already scanned.
 *
 * Pure and synchronous — no FS, no async — so it's unit-testable like a parser
 * and runnable client-side in the Operations panel. It only reshapes
 * already-populated fields (`cicd`, `externalServices`, `database`,
 * `operations`); it adds no new detection.
 */
export function deriveOpsSummary(p: OpsInput): OpsSummary {
  const deployTargets: HostingTarget[] = p.cicd?.hosting ?? [];
  const services = p.externalServices ?? [];
  const dependabot = p.cicd?.dependabot ?? [];

  // Merge Vercel crons and GitHub Actions `schedule:` crons into one list so
  // every scheduled job surfaces together regardless of where it's defined.
  const crons: OpsCron[] = [
    ...(p.cicd?.vercelCrons ?? []).map(
      (c): OpsCron => ({
        schedule: c.schedule,
        path: c.path,
        source: "vercel",
        sourcePath: c.sourcePath,
      }),
    ),
    ...(p.cicd?.workflows ?? []).flatMap((w) =>
      w.cron.map(
        (schedule): OpsCron => ({
          schedule,
          source: "workflow",
          sourcePath: w.file,
        }),
      ),
    ),
  ];

  // Honest coverage: count populated auto-detected groups vs. the five expected
  // curated runbook sections (unknown `other` sections don't count toward the
  // five facts), so the panel can nudge toward filling the runbook.
  const autoGroups =
    (deployTargets.length > 0 ? 1 : 0) +
    (services.length > 0 ? 1 : 0) +
    (p.database ? 1 : 0) +
    (crons.length > 0 ? 1 : 0);
  const curatedSections =
    p.operations?.sections.filter((s) => s.key !== "other").length ?? 0;

  return {
    deployTargets,
    services,
    database: p.database,
    crons,
    dependabot,
    runbook: p.operations,
    coverage: { autoGroups, curatedSections, curatedTotal: 5 },
  };
}

/** True when there's anything operational worth a tab (drives panel visibility). */
export function hasOps(s: OpsSummary): boolean {
  return (
    s.deployTargets.length > 0 ||
    s.services.length > 0 ||
    !!s.database ||
    s.crons.length > 0 ||
    s.dependabot.length > 0 ||
    !!s.runbook
  );
}
