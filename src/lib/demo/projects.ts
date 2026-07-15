import type {
  ProjectData,
  ScanResult,
  ClaudeMdAuditInfo,
  BoardInfo,
  InsightsInfo,
  ManualStepsInfo,
  OperationsInfo,
  TodoInfo,
  PortConflict,
} from "@/lib/types";

/**
 * Synthetic project fixtures for demo mode. Deterministic (no randomness) and
 * anchored to a `nowMs` passed at request time, so relative times ("2h ago",
 * "today") stay fresh across runs while the structure is byte-stable. Returned
 * from a guard atop `scanAllProjects()`, so this one fixture lights up the
 * dashboard, project detail, board, insights, manual-steps, ops, and stats.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO timestamp `offsetMs` in the past relative to `nowMs`. */
function iso(nowMs: number, offsetMs: number): string {
  return new Date(nowMs - offsetMs).toISOString();
}

function presentAudit(score: number): ClaudeMdAuditInfo {
  return {
    hasClaudeMd: true,
    score,
    projectLines: 210,
    importCount: 4,
    fileBytes: 9_400,
    rulesLines: 72,
    rulesFileCount: 3,
    findings:
      score < 90
        ? [
            {
              code: "long-index",
              severity: "P2",
              title: "CLAUDE.md index is on the long side",
              fix: "Move rule blocks into topic files and @import them.",
              penalty: 100 - score,
            },
          ]
        : [],
  };
}

const absentAudit: ClaudeMdAuditInfo = {
  hasClaudeMd: false,
  findings: [
    {
      code: "no-claude-md",
      severity: "P1",
      title: "No CLAUDE.md",
      fix: "Add a CLAUDE.md so Claude Code has project context.",
      penalty: 0,
    },
  ],
};

function demoTodos(): TodoInfo {
  const items = [
    { text: "Wire the checkout webhook to the fulfilment queue", completed: false, lineNumber: 3 },
    { text: "Add optimistic UI to the cart drawer", completed: false, lineNumber: 4 },
    { text: "Backfill product search index", completed: true, lineNumber: 5 },
    { text: "Rate-limit the coupon endpoint", completed: false, lineNumber: 6 },
  ];
  const completed = items.filter((i) => i.completed).length;
  return { total: items.length, completed, pending: items.length - completed, items };
}

function demoInsights(nowMs: number, slug: string, path: string): InsightsInfo {
  const entries = [
    {
      content:
        "Keying the scan cache by absolute path (not slug) fixed the worktree-vs-parent collision — two checkouts of the same repo no longer clobber each other's cached data.",
      offset: 6 * HOUR,
    },
    {
      content:
        "The Stripe webhook was retried because we ACKed after the DB write, not before — moving the 200 ahead of the enqueue cut duplicate fulfilment to zero.",
      offset: 2 * DAY,
    },
    {
      content:
        "React Query's `staleTime` alone won't dedupe across components; sharing one queryKey factory is what actually collapsed the 3 redundant fetches.",
      offset: 5 * DAY,
    },
  ];
  return {
    total: entries.length,
    entries: entries.map((e, i) => ({
      id: `${slug}-insight-${i}`,
      content: e.content,
      sessionId: `demo-sess-${slug}-${i}`,
      date: iso(nowMs, e.offset),
      project: slug,
      projectPath: path,
    })),
  };
}

function demoManualSteps(nowMs: number): ManualStepsInfo {
  const entries = [
    {
      date: new Date(nowMs - 3 * HOUR).toISOString().slice(0, 16).replace("T", " "),
      featureSlug: "billing",
      title: "Stripe + Vercel billing setup",
      steps: [
        {
          text: "Add STRIPE_SECRET_KEY to the Vercel project",
          completed: true,
          details: ["Settings → Environment Variables → Production"],
          lineNumber: 3,
        },
        {
          text: "Create the webhook endpoint in the Stripe dashboard",
          completed: false,
          details: ["URL: https://app.example.com/api/stripe/webhook", "Events: checkout.session.completed"],
          lineNumber: 4,
        },
        {
          text: "Run the Drizzle migration on the production branch",
          completed: false,
          details: ["`pnpm drizzle-kit push`"],
          lineNumber: 6,
        },
      ],
    },
  ];
  const all = entries.flatMap((e) => e.steps);
  const completedSteps = all.filter((s) => s.completed).length;
  return {
    entries,
    totalSteps: all.length,
    pendingSteps: all.length - completedSteps,
    completedSteps,
  };
}

function demoBoard(): BoardInfo {
  const epics = [
    {
      id: "e-checkout",
      title: "Checkout & payments",
      status: "doing" as const,
      priority: "high" as const,
      labels: ["revenue"],
      description: "End-to-end purchase flow, Stripe, and fulfilment.",
      line: 3,
      order: 0,
      issues: [
        {
          id: "i-webhook",
          title: "Idempotent Stripe webhook handler",
          status: "doing" as const,
          priority: "high" as const,
          labels: ["backend"],
          epicId: "e-checkout",
          detail: "ACK before enqueue; dedupe on event id.",
          line: 4,
          order: 0,
        },
        {
          id: "i-cart",
          title: "Optimistic cart drawer",
          status: "todo" as const,
          priority: "med" as const,
          labels: ["frontend"],
          epicId: "e-checkout",
          line: 5,
          order: 1,
        },
        {
          id: "i-receipt",
          title: "Emailed receipts",
          status: "done" as const,
          labels: [],
          epicId: "e-checkout",
          line: 6,
          order: 2,
        },
      ],
    },
    {
      id: "e-search",
      title: "Product search",
      status: "backlog" as const,
      priority: "med" as const,
      labels: [],
      line: 8,
      order: 1,
      issues: [
        {
          id: "i-index",
          title: "Nightly search-index backfill",
          status: "backlog" as const,
          priority: "low" as const,
          labels: ["ops"],
          epicId: "e-search",
          line: 9,
          order: 0,
        },
      ],
    },
  ];
  const inbox = [
    {
      id: "i-triage-1",
      title: "(finding) Coupon endpoint isn't rate-limited",
      status: "triage" as const,
      priority: "high" as const,
      labels: ["security"],
      detail: "Surfaced by the burn HUD demo session.",
      line: 12,
      order: 0,
    },
  ];
  const total = epics.reduce((n, e) => n + e.issues.length, 0) + inbox.length;
  return { epics, inbox, total };
}

function demoOps(): OperationsInfo {
  const sections = [
    {
      key: "backups" as const,
      heading: "Backups",
      body: "",
      line: 3,
      items: [
        {
          text: "Neon daily automated backups, 7-day PITR",
          done: true,
          details: ["Retention: 7 days", "Verified restore monthly"],
          lineNumber: 4,
        },
      ],
    },
    {
      key: "monitoring" as const,
      heading: "Monitoring & Alerting",
      body: "",
      line: 7,
      items: [
        { text: "Better Uptime check on /api/health", done: true, details: [], lineNumber: 8 },
        { text: "Sentry alerts route to #oncall", done: false, details: [], lineNumber: 9 },
      ],
    },
    {
      key: "oncall" as const,
      heading: "On-call & Escalation",
      body: "Primary: whoever merged last. Escalate to the founder after 30m.",
      line: 12,
      items: [],
    },
  ];
  const all = sections.flatMap((s) => s.items);
  return {
    sections,
    totalItems: all.length,
    pendingItems: all.filter((i) => !i.done).length,
  };
}

interface Seed {
  slug: string;
  name: string;
  status: ProjectData["status"];
  framework?: string;
  frameworkVersion?: string;
  dependencies: string[];
  externalServices?: string[];
  devPort?: number;
  branch: string;
  uncommittedCount: number;
  lastCommitMessage: string;
  commitOffset: number;
  sessionCount: number;
  sessionOffset: number;
  auditScore?: number; // omit → absent CLAUDE.md
  remoteUrl?: string;
  rich?: boolean; // board + insights + manual steps + ops
  insights?: boolean;
  todos?: boolean;
  manualSteps?: boolean;
}

const SEEDS: Seed[] = [
  {
    slug: "aurora-commerce",
    name: "aurora-commerce",
    status: "active",
    framework: "Next.js",
    frameworkVersion: "16.0.1",
    dependencies: ["next", "react", "drizzle-orm", "stripe", "@tanstack/react-query", "tailwindcss"],
    externalServices: ["Stripe", "Neon", "Resend"],
    devPort: 3000,
    branch: "feat/checkout-webhook",
    uncommittedCount: 7,
    lastCommitMessage: "feat: idempotent stripe webhook handler",
    commitOffset: 40 * MIN,
    sessionCount: 34,
    sessionOffset: 12 * MIN,
    auditScore: 88,
    remoteUrl: "https://github.com/acme/aurora-commerce.git",
    rich: true,
  },
  {
    slug: "pulse-analytics",
    name: "pulse-analytics",
    status: "active",
    framework: "Next.js",
    frameworkVersion: "15.4.2",
    dependencies: ["next", "react", "recharts", "@tanstack/react-query", "clickhouse"],
    externalServices: ["ClickHouse", "Upstash"],
    devPort: 3200,
    branch: "main",
    uncommittedCount: 0,
    lastCommitMessage: "perf: memoize the cohort rollup",
    commitOffset: 5 * HOUR,
    sessionCount: 21,
    sessionOffset: 3 * HOUR,
    auditScore: 94,
    remoteUrl: "https://github.com/acme/pulse-analytics.git",
    insights: true,
  },
  {
    slug: "quill-cms",
    name: "quill-cms",
    status: "active",
    framework: "Remix",
    frameworkVersion: "2.15.0",
    dependencies: ["@remix-run/node", "react", "prisma", "tailwindcss"],
    externalServices: ["PlanetScale"],
    devPort: 3400,
    branch: "feat/media-library",
    uncommittedCount: 3,
    lastCommitMessage: "wip: drag-drop media grid",
    commitOffset: 26 * HOUR,
    sessionCount: 12,
    sessionOffset: 22 * HOUR,
    auditScore: 71,
    remoteUrl: "https://github.com/acme/quill-cms.git",
    todos: true,
    manualSteps: true,
  },
  {
    slug: "ledger-api",
    name: "ledger-api",
    status: "active",
    framework: "NestJS",
    frameworkVersion: "10.4.0",
    dependencies: ["@nestjs/core", "typeorm", "bullmq", "ioredis"],
    externalServices: ["Railway", "Redis"],
    // Deliberately collides with aurora-commerce on :3000 so demo mode shows a
    // realistic port conflict (see DEMO_PORT_CONFLICTS).
    devPort: 3000,
    branch: "main",
    uncommittedCount: 0,
    lastCommitMessage: "chore: bump bullmq to 5.x",
    commitOffset: 2 * DAY,
    sessionCount: 9,
    sessionOffset: 30 * HOUR,
    auditScore: 82,
    remoteUrl: "https://github.com/acme/ledger-api.git",
    todos: true,
  },
  {
    slug: "atlas-cli",
    name: "atlas-cli",
    status: "paused",
    framework: "Node",
    dependencies: ["commander", "chalk", "execa"],
    branch: "main",
    uncommittedCount: 0,
    lastCommitMessage: "docs: flesh out the README examples",
    commitOffset: 9 * DAY,
    sessionCount: 4,
    sessionOffset: 8 * DAY,
    auditScore: 90,
  },
  {
    slug: "beacon-mobile",
    name: "beacon-mobile",
    status: "active",
    framework: "Expo",
    frameworkVersion: "52.0.0",
    dependencies: ["expo", "react-native", "react", "zustand"],
    externalServices: ["Supabase"],
    branch: "feat/push-notifications",
    uncommittedCount: 12,
    lastCommitMessage: "feat: expo push token registration",
    commitOffset: 4 * HOUR,
    sessionCount: 15,
    sessionOffset: 90 * MIN,
    remoteUrl: "https://github.com/acme/beacon-mobile.git",
    todos: true,
  },
  {
    slug: "synth-playground",
    name: "synth-playground",
    status: "active",
    framework: "Vite",
    frameworkVersion: "6.0.3",
    dependencies: ["vite", "react", "tone", "zustand"],
    branch: "main",
    uncommittedCount: 1,
    lastCommitMessage: "feat: sequencer swing control",
    commitOffset: 7 * HOUR,
    sessionCount: 6,
    sessionOffset: 6 * HOUR,
    insights: true,
  },
  {
    slug: "archive-legacy-dash",
    name: "archive-legacy-dash",
    status: "archived",
    framework: "Create React App",
    frameworkVersion: "5.0.1",
    dependencies: ["react-scripts", "react", "redux"],
    branch: "main",
    uncommittedCount: 0,
    lastCommitMessage: "chore: freeze — migrated to pulse-analytics",
    commitOffset: 140 * DAY,
    sessionCount: 2,
    sessionOffset: 130 * DAY,
  },
];

function buildProject(seed: Seed, nowMs: number): ProjectData {
  const rich = seed.rich === true;
  return {
    slug: seed.slug,
    name: seed.name,
    path: `C:\\dev\\${seed.slug}`,
    status: seed.status,
    usageSlug: `dev-${seed.slug}`,
    framework: seed.framework,
    frameworkVersion: seed.frameworkVersion,
    dependencies: seed.dependencies,
    dockerPorts: [],
    externalServices: seed.externalServices ?? [],
    devPort: seed.devPort,
    git: {
      branch: seed.branch,
      isDirty: seed.uncommittedCount > 0,
      uncommittedCount: seed.uncommittedCount,
      lastCommitDate: iso(nowMs, seed.commitOffset),
      lastCommitMessage: seed.lastCommitMessage,
      remoteUrl: seed.remoteUrl,
    },
    claude: {
      sessionCount: seed.sessionCount,
      lastSessionDate: iso(nowMs, seed.sessionOffset),
      lastPromptPreview:
        seed.status === "archived" ? "wrap up and archive this project" : "keep going on the current task",
      mostRecentSessionStatus: seed.uncommittedCount > 8 ? "working" : "idle",
    },
    claudeMdAudit: seed.auditScore === undefined ? absentAudit : presentAudit(seed.auditScore),
    todos: rich || seed.todos ? demoTodos() : undefined,
    manualSteps: rich || seed.manualSteps ? demoManualSteps(nowMs) : undefined,
    insights: rich || seed.insights ? demoInsights(nowMs, seed.slug, `C:\\dev\\${seed.slug}`) : undefined,
    board: rich ? demoBoard() : undefined,
    operations: rich ? demoOps() : undefined,
    lastActivity: iso(nowMs, Math.min(seed.sessionOffset, seed.commitOffset)),
    scannedAt: new Date(nowMs).toISOString(),
    // Payload-borne demo marker — lets the client hide the session-derived tabs
    // (Hot Files / Errors / Patterns) whose endpoints have no demo fixtures.
    demo: true,
  };
}

/** All demo projects, freshest-activity first — matching the real scanner,
 *  which sorts by `lastActivity` descending. ISO timestamps sort lexically. */
export function demoProjects(nowMs: number): ProjectData[] {
  return SEEDS.map((s) => buildProject(s, nowMs)).sort((a, b) =>
    (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""),
  );
}

/** aurora-commerce and ledger-api both advertise :3000, so the port-conflict
 *  indicator lights up in demo mode (their `devPort` fixtures agree). */
const DEMO_PORT_CONFLICTS: PortConflict[] = [
  { port: 3000, projects: ["aurora-commerce", "ledger-api"], type: "dev" },
];

/** The full `scanAllProjects()` result for demo mode. */
export function demoScanResult(nowMs: number): ScanResult {
  return {
    projects: demoProjects(nowMs),
    portConflicts: DEMO_PORT_CONFLICTS,
    hiddenCount: 0,
    scannedAt: new Date(nowMs).toISOString(),
    catalogLintFindings: [],
  };
}
