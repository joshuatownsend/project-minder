import { describe, it, expect } from "vitest";
import { deriveOpsSummary, hasOps } from "@/lib/ops/summary";
import type {
  CiCdInfo,
  DatabaseInfo,
  HostingTarget,
  OperationsInfo,
  VercelCron,
  Workflow,
} from "@/lib/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

function hostingTarget(platform: HostingTarget["platform"]): HostingTarget {
  return { platform, sourcePath: `/proj/${platform}.json` };
}

function vercelCron(path: string, schedule: string): VercelCron {
  return { path, schedule, sourcePath: "/proj/vercel.json" };
}

function workflow(file: string, cron: string[]): Workflow {
  return { file, triggers: ["schedule"], cron, jobs: [], parseOk: true };
}

function cicd(over: Partial<CiCdInfo> = {}): CiCdInfo {
  return {
    workflows: [],
    hosting: [],
    vercelCrons: [],
    dependabot: [],
    ...over,
  };
}

const db: DatabaseInfo = {
  type: "PostgreSQL",
  host: "db.neon.tech",
  port: 5432,
  name: "app",
};

function runbook(keys: OperationsInfo["sections"][number]["key"][]): OperationsInfo {
  const sections = keys.map((key, i) => ({
    key,
    heading: key,
    body: "",
    items: [],
    line: i + 1,
  }));
  return { sections, totalItems: 0, pendingItems: 0 };
}

// ── deriveOpsSummary ────────────────────────────────────────────────────────

describe("deriveOpsSummary", () => {
  it("passes deploy targets through from cicd.hosting", () => {
    const s = deriveOpsSummary({
      cicd: cicd({ hosting: [hostingTarget("vercel"), hostingTarget("docker")] }),
      externalServices: [],
      database: undefined,
      operations: undefined,
    });
    expect(s.deployTargets.map((h) => h.platform)).toEqual(["vercel", "docker"]);
  });

  it("passes services, database, and dependabot through", () => {
    const s = deriveOpsSummary({
      cicd: cicd({
        dependabot: [
          { ecosystem: "npm", sourcePath: "/proj/.github/dependabot.yml" },
        ],
      }),
      externalServices: ["Stripe", "Neon"],
      database: db,
      operations: undefined,
    });
    expect(s.services).toEqual(["Stripe", "Neon"]);
    expect(s.database).toEqual(db);
    expect(s.dependabot).toHaveLength(1);
    expect(s.dependabot[0].ecosystem).toBe("npm");
  });

  it("merges crons from both vercelCrons and workflows[].cron with correct source", () => {
    const s = deriveOpsSummary({
      cicd: cicd({
        vercelCrons: [vercelCron("/api/cron", "0 0 * * *")],
        workflows: [
          workflow("/proj/.github/workflows/nightly.yml", ["30 2 * * *", "0 12 * * 1"]),
        ],
      }),
      externalServices: [],
      database: undefined,
      operations: undefined,
    });
    expect(s.crons).toHaveLength(3);

    const vercel = s.crons.filter((c) => c.source === "vercel");
    expect(vercel).toHaveLength(1);
    expect(vercel[0]).toMatchObject({
      schedule: "0 0 * * *",
      path: "/api/cron",
      sourcePath: "/proj/vercel.json",
    });

    const wf = s.crons.filter((c) => c.source === "workflow");
    expect(wf.map((c) => c.schedule)).toEqual(["30 2 * * *", "0 12 * * 1"]);
    expect(wf[0].sourcePath).toBe("/proj/.github/workflows/nightly.yml");
    expect(wf[0].path).toBeUndefined();
  });

  it("yields empty arrays (no throws) when cicd is absent", () => {
    const s = deriveOpsSummary({
      cicd: undefined,
      externalServices: [],
      database: undefined,
      operations: undefined,
    });
    expect(s.deployTargets).toEqual([]);
    expect(s.crons).toEqual([]);
    expect(s.dependabot).toEqual([]);
    expect(s.services).toEqual([]);
    expect(s.database).toBeUndefined();
    expect(s.runbook).toBeUndefined();
  });

  it("counts populated auto-detected groups in coverage.autoGroups", () => {
    // deploy targets + services + database + crons = 4 groups
    const full = deriveOpsSummary({
      cicd: cicd({
        hosting: [hostingTarget("vercel")],
        vercelCrons: [vercelCron("/api/cron", "0 0 * * *")],
      }),
      externalServices: ["Stripe"],
      database: db,
      operations: undefined,
    });
    expect(full.coverage.autoGroups).toBe(4);
    expect(full.coverage.curatedTotal).toBe(5);

    const none = deriveOpsSummary({
      cicd: undefined,
      externalServices: [],
      database: undefined,
      operations: undefined,
    });
    expect(none.coverage.autoGroups).toBe(0);
  });

  it("counts only non-other runbook sections in coverage.curatedSections", () => {
    const s = deriveOpsSummary({
      cicd: undefined,
      externalServices: [],
      database: undefined,
      operations: runbook(["backups", "monitoring", "other"]),
    });
    expect(s.coverage.curatedSections).toBe(2);
    expect(s.runbook?.sections).toHaveLength(3);
  });
});

// ── hasOps ──────────────────────────────────────────────────────────────────

describe("hasOps", () => {
  it("is false for a fully-empty project", () => {
    const s = deriveOpsSummary({
      cicd: undefined,
      externalServices: [],
      database: undefined,
      operations: undefined,
    });
    expect(hasOps(s)).toBe(false);
  });

  it("is true when any single group is present", () => {
    expect(
      hasOps(
        deriveOpsSummary({
          cicd: cicd({ hosting: [hostingTarget("fly")] }),
          externalServices: [],
          database: undefined,
          operations: undefined,
        }),
      ),
    ).toBe(true);

    expect(
      hasOps(
        deriveOpsSummary({
          cicd: undefined,
          externalServices: ["Resend"],
          database: undefined,
          operations: undefined,
        }),
      ),
    ).toBe(true);

    expect(
      hasOps(
        deriveOpsSummary({
          cicd: undefined,
          externalServices: [],
          database: db,
          operations: undefined,
        }),
      ),
    ).toBe(true);

    expect(
      hasOps(
        deriveOpsSummary({
          cicd: undefined,
          externalServices: [],
          database: undefined,
          operations: runbook(["restore"]),
        }),
      ),
    ).toBe(true);
  });
});
