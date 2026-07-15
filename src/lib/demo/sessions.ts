import type {
  SessionSummary,
  SessionDetail,
  SessionStatus,
  TimelineEvent,
  FileOperation,
  SubagentInfo,
  PrLink,
  TicketLink,
} from "@/lib/types";
import type { SessionsListResult, SessionDetailResult } from "@/lib/data";

/**
 * Synthetic Claude Code session fixtures for demo mode. Deterministic (no
 * randomness) and anchored to a `nowMs` passed at request time, so relative
 * times ("2h ago") stay fresh across runs while the structure is byte-stable.
 *
 * Returned from a guard atop the `data/index.ts` session façade
 * (`getSessionsList` / `resolveSessionDetail`), ABOVE the DB/file branch — see
 * `demoMode.ts` for the injection-point rationale.
 *
 * Keying to match the real file-parse path (`scanAllSessions`):
 *   - `projectPath`  = `C:\dev\<slug>`               (decoded absolute path)
 *   - `projectName`  = `C--dev-<slug>`               (encoded conversation-dir
 *                       name — the per-project Sessions tab filters on this via
 *                       `projectName === projectPath.replace(/[:\\/]/g,"-")`)
 *   - `projectSlug`  = `dev-<slug>`                  (`toSlug(dirName)` output —
 *                       the `/api/sessions?project=` filter matches on this,
 *                       and it equals `ProjectData.usageSlug`)
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO timestamp `offsetMs` in the past relative to `nowMs`. */
function iso(nowMs: number, offsetMs: number): string {
  return new Date(nowMs - offsetMs).toISOString();
}

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-5";
const HAIKU = "claude-haiku-4-5";

interface ProjectRef {
  path: string;
  name: string;
  projectSlug: string;
}

/** Build the three keyed fields from a route slug (e.g. "aurora-commerce"). */
function proj(slug: string): ProjectRef {
  return {
    path: `C:\\dev\\${slug}`,
    name: `C--dev-${slug}`,
    projectSlug: `dev-${slug}`,
  };
}

/** Compact per-session spec; expanded into a full SessionSummary by `toSummary`. */
interface SessionSeed {
  id: string;
  slug: string; // Claude Code nickname (e.g. "quirky-scribbling-plum")
  project: string; // route slug
  startOffset: number; // ms ago the session started
  durationMs: number;
  initialPrompt: string;
  lastRecap?: string;
  branch?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costEstimate: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolUsage: Record<string, number>;
  models: string[];
  subagentCount: number;
  errorCount: number;
  oneShotRate?: number;
  skillsUsed?: Record<string, number>;
  status: SessionStatus;
  isActive?: boolean;
  prs?: PrLink[];
  tickets?: TicketLink[];
  // Detail-only enrichment (used by demoSessionDetail):
  files?: Array<{ path: string; operation: string; toolName: string }>;
  subagents?: Array<{ type: string; description: string }>;
}

const SEEDS: SessionSeed[] = [
  // ── aurora-commerce (many) ────────────────────────────────────────────
  {
    id: "demo-aurora-commerce-1",
    slug: "quirky-scribbling-plum",
    project: "aurora-commerce",
    startOffset: 42 * MIN,
    durationMs: 28 * MIN,
    initialPrompt:
      "The Stripe webhook is firing fulfilment twice on retries — make the handler idempotent by deduping on the event id.",
    lastRecap:
      "Made the Stripe webhook idempotent: ACK before enqueue and dedupe on event.id via a processed_events table. Duplicate fulfilment dropped to zero in the replay test.",
    branch: "feat/checkout-webhook",
    inputTokens: 184_320,
    outputTokens: 24_880,
    cacheReadTokens: 512_400,
    cacheCreateTokens: 61_200,
    costEstimate: 3.42,
    messageCount: 78,
    userMessageCount: 14,
    assistantMessageCount: 64,
    toolUsage: { Read: 22, Edit: 11, Bash: 9, Grep: 7, Write: 2 },
    models: [OPUS, HAIKU],
    subagentCount: 2,
    errorCount: 1,
    oneShotRate: 0.82,
    skillsUsed: { "stripe:stripe-best-practices": 1 },
    status: "idle",
    prs: [{ url: "https://github.com/acme/aurora-commerce/pull/412", number: 412, repo: "acme/aurora-commerce" }],
    tickets: [{ provider: "linear", key: "AUR-231", url: "https://linear.app/acme/issue/AUR-231" }],
    files: [
      { path: "src/app/api/stripe/webhook/route.ts", operation: "edit", toolName: "Edit" },
      { path: "src/lib/payments/dedupe.ts", operation: "create", toolName: "Write" },
      { path: "drizzle/0007_processed_events.sql", operation: "create", toolName: "Write" },
      { path: "tests/stripe-webhook.test.ts", operation: "edit", toolName: "Edit" },
    ],
    subagents: [
      { type: "general-purpose", description: "Trace every call site that enqueues fulfilment jobs" },
      { type: "code-reviewer", description: "Review the idempotency change for race conditions" },
    ],
  },
  {
    id: "demo-aurora-commerce-2",
    slug: "dapper-humming-otter",
    project: "aurora-commerce",
    startOffset: 5 * HOUR,
    durationMs: 51 * MIN,
    initialPrompt:
      "Add an optimistic UI to the cart drawer so quantity changes feel instant, then reconcile with the server response.",
    lastRecap:
      "Cart drawer now updates optimistically via a React Query mutation with rollback on error. Added a reconciliation pass keyed on the cart version.",
    branch: "feat/optimistic-cart",
    inputTokens: 142_100,
    outputTokens: 19_450,
    cacheReadTokens: 388_900,
    cacheCreateTokens: 44_700,
    costEstimate: 2.61,
    messageCount: 62,
    userMessageCount: 11,
    assistantMessageCount: 51,
    toolUsage: { Read: 18, Edit: 14, Bash: 6, Grep: 5 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 0.9,
    status: "idle",
    files: [
      { path: "src/components/CartDrawer.tsx", operation: "edit", toolName: "Edit" },
      { path: "src/hooks/useCartMutation.ts", operation: "create", toolName: "Write" },
    ],
  },
  {
    id: "demo-aurora-commerce-3",
    slug: "brisk-tumbling-finch",
    project: "aurora-commerce",
    startOffset: 27 * HOUR,
    durationMs: 22 * MIN,
    initialPrompt: "Rate-limit the coupon endpoint — it's being brute-forced for valid codes.",
    lastRecap:
      "Added a sliding-window rate limiter (Upstash) on /api/coupon with a 10/min per-IP budget and a 429 + Retry-After response.",
    branch: "feat/coupon-ratelimit",
    inputTokens: 96_800,
    outputTokens: 12_300,
    cacheReadTokens: 210_400,
    cacheCreateTokens: 28_900,
    costEstimate: 1.44,
    messageCount: 40,
    userMessageCount: 8,
    assistantMessageCount: 32,
    toolUsage: { Read: 12, Edit: 6, Bash: 4, Grep: 4, WebFetch: 1 },
    models: [SONNET, HAIKU],
    subagentCount: 0,
    errorCount: 2,
    oneShotRate: 0.71,
    status: "needs_attention",
    tickets: [{ provider: "github", key: "acme/aurora-commerce#398", url: "https://github.com/acme/aurora-commerce/issues/398" }],
    files: [
      { path: "src/app/api/coupon/route.ts", operation: "edit", toolName: "Edit" },
      { path: "src/lib/ratelimit.ts", operation: "create", toolName: "Write" },
    ],
  },
  {
    id: "demo-aurora-commerce-4",
    slug: "gentle-roaming-lynx",
    project: "aurora-commerce",
    startOffset: 3 * DAY,
    durationMs: 1 * HOUR + 12 * MIN,
    initialPrompt: "Backfill the product search index and wire a nightly cron to keep it fresh.",
    lastRecap:
      "Backfilled 48k products into the search index and added a Vercel cron at 02:00 UTC. Indexing runs in batches of 500 with a resumable cursor.",
    branch: "main",
    inputTokens: 221_600,
    outputTokens: 31_200,
    cacheReadTokens: 604_100,
    cacheCreateTokens: 72_300,
    costEstimate: 4.18,
    messageCount: 96,
    userMessageCount: 17,
    assistantMessageCount: 79,
    toolUsage: { Read: 28, Edit: 15, Bash: 18, Grep: 9, Write: 3 },
    models: [OPUS, SONNET],
    subagentCount: 3,
    errorCount: 1,
    oneShotRate: 0.86,
    skillsUsed: { "context-mode:context-mode": 2 },
    status: "idle",
    files: [
      { path: "scripts/backfill-search.ts", operation: "create", toolName: "Write" },
      { path: "src/lib/search/indexer.ts", operation: "edit", toolName: "Edit" },
      { path: "vercel.json", operation: "edit", toolName: "Edit" },
    ],
    subagents: [
      { type: "general-purpose", description: "Find every product field that should be searchable" },
      { type: "Explore", description: "Locate the existing indexer and its batch config" },
      { type: "code-reviewer", description: "Check the resumable cursor for off-by-one gaps" },
    ],
  },
  {
    id: "demo-aurora-commerce-5",
    slug: "sunny-drifting-heron",
    project: "aurora-commerce",
    startOffset: 8 * MIN,
    durationMs: 8 * MIN,
    initialPrompt: "Emailed receipts render the wrong currency for EU orders — fix the money formatting.",
    branch: "feat/checkout-webhook",
    inputTokens: 41_200,
    outputTokens: 5_600,
    cacheReadTokens: 88_400,
    cacheCreateTokens: 14_200,
    costEstimate: 0.62,
    messageCount: 18,
    userMessageCount: 4,
    assistantMessageCount: 14,
    toolUsage: { Read: 6, Edit: 3, Bash: 2 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 1,
    status: "working",
    isActive: true,
    files: [{ path: "src/lib/email/receipt.tsx", operation: "edit", toolName: "Edit" }],
  },

  // ── pulse-analytics ───────────────────────────────────────────────────
  {
    id: "demo-pulse-analytics-1",
    slug: "mellow-glinting-otter",
    project: "pulse-analytics",
    startOffset: 3 * HOUR,
    durationMs: 44 * MIN,
    initialPrompt: "The cohort rollup query is slow on 90-day windows — memoize it and add a materialized view.",
    lastRecap:
      "Memoized the cohort rollup and materialized the 90-day aggregate in ClickHouse. p95 dropped from 3.1s to 240ms.",
    branch: "main",
    inputTokens: 158_400,
    outputTokens: 21_100,
    cacheReadTokens: 402_600,
    cacheCreateTokens: 49_800,
    costEstimate: 2.88,
    messageCount: 58,
    userMessageCount: 12,
    assistantMessageCount: 46,
    toolUsage: { Read: 16, Edit: 9, Bash: 12, Grep: 6 },
    models: [OPUS, HAIKU],
    subagentCount: 1,
    errorCount: 0,
    oneShotRate: 0.88,
    status: "idle",
    files: [
      { path: "src/queries/cohortRollup.ts", operation: "edit", toolName: "Edit" },
      { path: "clickhouse/mv_cohort_90d.sql", operation: "create", toolName: "Write" },
    ],
    subagents: [{ type: "general-purpose", description: "Profile the cohort query and identify the hot join" }],
  },
  {
    id: "demo-pulse-analytics-2",
    slug: "wistful-arcing-crane",
    project: "pulse-analytics",
    startOffset: 20 * HOUR,
    durationMs: 33 * MIN,
    initialPrompt: "Add a funnel chart to the dashboard with drop-off percentages between steps.",
    branch: "feat/funnel-chart",
    inputTokens: 112_700,
    outputTokens: 15_900,
    cacheReadTokens: 288_100,
    cacheCreateTokens: 33_400,
    costEstimate: 2.02,
    messageCount: 46,
    userMessageCount: 9,
    assistantMessageCount: 37,
    toolUsage: { Read: 14, Edit: 10, Bash: 4, Grep: 3 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 1,
    oneShotRate: 0.79,
    status: "idle",
    files: [{ path: "src/components/FunnelChart.tsx", operation: "create", toolName: "Write" }],
  },
  {
    id: "demo-pulse-analytics-3",
    slug: "brave-coasting-vireo",
    project: "pulse-analytics",
    startOffset: 4 * DAY,
    durationMs: 19 * MIN,
    initialPrompt: "Fix the timezone bug in the daily active users chart — it's double-counting around midnight UTC.",
    branch: "main",
    inputTokens: 68_300,
    outputTokens: 8_900,
    cacheReadTokens: 151_200,
    cacheCreateTokens: 20_600,
    costEstimate: 1.09,
    messageCount: 30,
    userMessageCount: 6,
    assistantMessageCount: 24,
    toolUsage: { Read: 9, Edit: 4, Bash: 3, Grep: 3 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 0.92,
    status: "idle",
    files: [{ path: "src/queries/dau.ts", operation: "edit", toolName: "Edit" }],
  },

  // ── quill-cms ─────────────────────────────────────────────────────────
  {
    id: "demo-quill-cms-1",
    slug: "clever-folding-marten",
    project: "quill-cms",
    startOffset: 22 * HOUR,
    durationMs: 58 * MIN,
    initialPrompt: "Build a drag-and-drop media grid for the media library with reorder persistence.",
    lastRecap:
      "Shipped a drag-drop media grid using dnd-kit; order persists to Prisma via a batched position update. Still WIP on touch devices.",
    branch: "feat/media-library",
    inputTokens: 176_900,
    outputTokens: 23_700,
    cacheReadTokens: 421_800,
    cacheCreateTokens: 52_100,
    costEstimate: 3.11,
    messageCount: 70,
    userMessageCount: 13,
    assistantMessageCount: 57,
    toolUsage: { Read: 20, Edit: 13, Bash: 7, Grep: 6, Write: 2 },
    models: [OPUS, SONNET],
    subagentCount: 1,
    errorCount: 3,
    oneShotRate: 0.68,
    status: "needs_attention",
    files: [
      { path: "app/routes/media.tsx", operation: "edit", toolName: "Edit" },
      { path: "app/components/MediaGrid.tsx", operation: "create", toolName: "Write" },
      { path: "prisma/schema.prisma", operation: "edit", toolName: "Edit" },
    ],
    subagents: [{ type: "general-purpose", description: "Compare dnd-kit vs react-dnd for the media grid" }],
  },
  {
    id: "demo-quill-cms-2",
    slug: "quiet-nesting-plover",
    project: "quill-cms",
    startOffset: 2 * DAY,
    durationMs: 26 * MIN,
    initialPrompt: "Add draft autosave to the post editor with a debounced mutation.",
    branch: "main",
    inputTokens: 84_600,
    outputTokens: 11_400,
    cacheReadTokens: 192_300,
    cacheCreateTokens: 25_800,
    costEstimate: 1.36,
    messageCount: 36,
    userMessageCount: 7,
    assistantMessageCount: 29,
    toolUsage: { Read: 11, Edit: 6, Bash: 3, Grep: 2 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 0.85,
    status: "idle",
    files: [{ path: "app/components/PostEditor.tsx", operation: "edit", toolName: "Edit" }],
  },

  // ── ledger-api ────────────────────────────────────────────────────────
  {
    id: "demo-ledger-api-1",
    slug: "steady-humming-bison",
    project: "ledger-api",
    startOffset: 30 * HOUR,
    durationMs: 47 * MIN,
    initialPrompt: "Migrate the queue from Bull to BullMQ 5 and move retry config to per-job options.",
    lastRecap:
      "Migrated to BullMQ 5. Retries are now per-job with exponential backoff; the dead-letter queue routes to a review worker.",
    branch: "main",
    inputTokens: 149_200,
    outputTokens: 20_300,
    cacheReadTokens: 356_700,
    cacheCreateTokens: 43_900,
    costEstimate: 2.67,
    messageCount: 54,
    userMessageCount: 10,
    assistantMessageCount: 44,
    toolUsage: { Read: 17, Edit: 12, Bash: 9, Grep: 5 },
    models: [OPUS, HAIKU],
    subagentCount: 2,
    errorCount: 1,
    oneShotRate: 0.8,
    status: "idle",
    files: [
      { path: "src/queue/processor.ts", operation: "edit", toolName: "Edit" },
      { path: "src/queue/deadLetter.ts", operation: "create", toolName: "Write" },
    ],
    subagents: [
      { type: "general-purpose", description: "Enumerate every Bull API used across the codebase" },
      { type: "code-reviewer", description: "Verify the backoff config matches the old semantics" },
    ],
  },
  {
    id: "demo-ledger-api-2",
    slug: "prudent-tallying-heron",
    project: "ledger-api",
    startOffset: 5 * DAY,
    durationMs: 31 * MIN,
    initialPrompt: "Add double-entry validation so a posted transaction's debits and credits must net to zero.",
    branch: "main",
    inputTokens: 102_400,
    outputTokens: 13_800,
    cacheReadTokens: 233_500,
    cacheCreateTokens: 29_700,
    costEstimate: 1.61,
    messageCount: 42,
    userMessageCount: 8,
    assistantMessageCount: 34,
    toolUsage: { Read: 13, Edit: 7, Bash: 6, Grep: 4 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 0.91,
    status: "idle",
    files: [{ path: "src/ledger/postTransaction.ts", operation: "edit", toolName: "Edit" }],
  },

  // ── beacon-mobile ─────────────────────────────────────────────────────
  {
    id: "demo-beacon-mobile-1",
    slug: "eager-pinging-swift",
    project: "beacon-mobile",
    startOffset: 90 * MIN,
    durationMs: 39 * MIN,
    initialPrompt: "Wire up Expo push notifications: register the device token and store it in Supabase.",
    lastRecap:
      "Expo push token registration works end to end — token stored in Supabase on login and refreshed on app foreground. Server can now send test pushes.",
    branch: "feat/push-notifications",
    inputTokens: 133_500,
    outputTokens: 18_100,
    cacheReadTokens: 312_900,
    cacheCreateTokens: 38_600,
    costEstimate: 2.34,
    messageCount: 52,
    userMessageCount: 11,
    assistantMessageCount: 41,
    toolUsage: { Read: 15, Edit: 10, Bash: 7, Grep: 4, Write: 1 },
    models: [OPUS, SONNET],
    subagentCount: 1,
    errorCount: 2,
    oneShotRate: 0.74,
    status: "working",
    isActive: true,
    files: [
      { path: "src/notifications/registerPush.ts", operation: "create", toolName: "Write" },
      { path: "src/screens/Login.tsx", operation: "edit", toolName: "Edit" },
    ],
    subagents: [{ type: "general-purpose", description: "Check Expo push setup steps and required permissions" }],
  },
  {
    id: "demo-beacon-mobile-2",
    slug: "nimble-hopping-vole",
    project: "beacon-mobile",
    startOffset: 3 * DAY,
    durationMs: 24 * MIN,
    initialPrompt: "Fix the Zustand store re-rendering the whole map on every location tick.",
    branch: "main",
    inputTokens: 71_800,
    outputTokens: 9_600,
    cacheReadTokens: 164_200,
    cacheCreateTokens: 21_400,
    costEstimate: 1.14,
    messageCount: 32,
    userMessageCount: 6,
    assistantMessageCount: 26,
    toolUsage: { Read: 10, Edit: 5, Bash: 3, Grep: 3 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 0.87,
    status: "idle",
    files: [{ path: "src/store/location.ts", operation: "edit", toolName: "Edit" }],
  },

  // ── synth-playground ──────────────────────────────────────────────────
  {
    id: "demo-synth-playground-1",
    slug: "playful-looping-wren",
    project: "synth-playground",
    startOffset: 6 * HOUR,
    durationMs: 35 * MIN,
    initialPrompt: "Add a swing control to the sequencer that shifts every off-beat step by a percentage.",
    lastRecap:
      "Added a swing knob (0-75%) that delays odd 16th-notes via Tone.js. Groove feels right at 55%.",
    branch: "main",
    inputTokens: 89_300,
    outputTokens: 12_700,
    cacheReadTokens: 198_400,
    cacheCreateTokens: 26_100,
    costEstimate: 1.47,
    messageCount: 38,
    userMessageCount: 8,
    assistantMessageCount: 30,
    toolUsage: { Read: 11, Edit: 8, Bash: 3, Grep: 2 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 0.9,
    status: "idle",
    files: [{ path: "src/audio/sequencer.ts", operation: "edit", toolName: "Edit" }],
  },

  // ── atlas-cli (few) ───────────────────────────────────────────────────
  {
    id: "demo-atlas-cli-1",
    slug: "tidy-listing-shrew",
    project: "atlas-cli",
    startOffset: 8 * DAY,
    durationMs: 17 * MIN,
    initialPrompt: "Flesh out the README with usage examples for each subcommand.",
    branch: "main",
    inputTokens: 52_600,
    outputTokens: 7_400,
    cacheReadTokens: 108_900,
    cacheCreateTokens: 16_200,
    costEstimate: 0.83,
    messageCount: 24,
    userMessageCount: 5,
    assistantMessageCount: 19,
    toolUsage: { Read: 8, Edit: 4, Bash: 2 },
    models: [HAIKU, SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 1,
    status: "idle",
    files: [{ path: "README.md", operation: "edit", toolName: "Edit" }],
  },

  // ── archive-legacy-dash (few) ─────────────────────────────────────────
  {
    id: "demo-archive-legacy-dash-1",
    slug: "faded-settling-moth",
    project: "archive-legacy-dash",
    startOffset: 130 * DAY,
    durationMs: 21 * MIN,
    initialPrompt: "Freeze this project — add a deprecation banner pointing users to pulse-analytics.",
    lastRecap: "Added a deprecation banner and froze the dashboard. Migration note points at pulse-analytics.",
    branch: "main",
    inputTokens: 44_800,
    outputTokens: 6_100,
    cacheReadTokens: 92_300,
    cacheCreateTokens: 13_700,
    costEstimate: 0.7,
    messageCount: 20,
    userMessageCount: 4,
    assistantMessageCount: 16,
    toolUsage: { Read: 6, Edit: 3, Bash: 1 },
    models: [SONNET],
    subagentCount: 0,
    errorCount: 0,
    oneShotRate: 0.95,
    status: "idle",
    files: [{ path: "src/App.js", operation: "edit", toolName: "Edit" }],
  },
];

/** Expand a seed into a full SessionSummary anchored to `nowMs`. */
function toSummary(seed: SessionSeed, nowMs: number): SessionSummary {
  const p = proj(seed.project);
  const startTime = iso(nowMs, seed.startOffset);
  const endTime = iso(nowMs, Math.max(0, seed.startOffset - seed.durationMs));
  const searchParts = [seed.initialPrompt, seed.lastRecap ?? "", seed.branch ?? ""];
  return {
    sessionId: seed.id,
    projectPath: p.path,
    projectSlug: p.projectSlug,
    projectName: p.name,
    startTime,
    endTime,
    durationMs: seed.durationMs,
    initialPrompt: seed.initialPrompt,
    lastPrompt: undefined,
    recaps: seed.lastRecap
      ? [{ content: seed.lastRecap, timestamp: endTime, slug: seed.slug }]
      : undefined,
    messageCount: seed.messageCount,
    userMessageCount: seed.userMessageCount,
    assistantMessageCount: seed.assistantMessageCount,
    inputTokens: seed.inputTokens,
    outputTokens: seed.outputTokens,
    cacheReadTokens: seed.cacheReadTokens,
    cacheCreateTokens: seed.cacheCreateTokens,
    costEstimate: seed.costEstimate,
    toolUsage: seed.toolUsage,
    modelsUsed: seed.models,
    gitBranch: seed.branch,
    subagentCount: seed.subagentCount,
    errorCount: seed.errorCount,
    isActive: seed.isActive === true,
    status: seed.status,
    skillsUsed: seed.skillsUsed ?? {},
    oneShotRate: seed.oneShotRate,
    searchableText: searchParts.join(" ").trim().slice(0, 4000),
    slug: seed.slug,
    cacheHitRatio:
      seed.cacheReadTokens + seed.cacheCreateTokens > 0
        ? seed.cacheReadTokens / (seed.cacheReadTokens + seed.cacheCreateTokens)
        : undefined,
    maxContextFill: 0.42,
    hasThinking: seed.models.includes(OPUS),
    isWorktree: false,
    source: "claude",
    prs: seed.prs,
    tickets: seed.tickets,
  };
}

function deriveMaxMs(sessions: SessionSummary[]): number {
  let max = 0;
  for (const s of sessions) {
    const ts = s.endTime ?? s.startTime;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max;
}

/**
 * Cross-project session list wrapped as a `SessionsListResult` (freshest —
 * smallest startOffset — first), matching `getSessionsList()`. `backend: "file"`
 * is the honest label since these fixtures never touch the SQLite index.
 */
export function demoSessionsList(nowMs: number): SessionsListResult {
  const sessions = SEEDS.slice()
    .sort((a, b) => a.startOffset - b.startOffset)
    .map((s) => toSummary(s, nowMs));
  return { sessions, meta: { backend: "file", maxMtimeMs: deriveMaxMs(sessions) } };
}

// ─── Detail construction ─────────────────────────────────────────────────

function buildTimeline(seed: SessionSeed, nowMs: number): TimelineEvent[] {
  const start = nowMs - seed.startOffset;
  const end = nowMs - Math.max(0, seed.startOffset - seed.durationMs);
  const span = Math.max(1, end - start);
  const events: TimelineEvent[] = [];

  events.push({ type: "user", timestamp: new Date(start).toISOString(), content: seed.initialPrompt });

  if (seed.models.includes(OPUS)) {
    events.push({
      type: "thinking",
      timestamp: new Date(start + span * 0.05).toISOString(),
      content: "Considering the failure mode and where the change is safest to make.",
      turnIndex: 0,
    });
  }

  events.push({
    type: "assistant",
    timestamp: new Date(start + span * 0.1).toISOString(),
    content: "Let me look at the relevant files and understand the current behavior.",
    tokenCount: 640,
  });

  // Tool-use events derived from the seed's file operations + tool tallies.
  const files = seed.files ?? [];
  const toolNames = Object.keys(seed.toolUsage);
  const steps = Math.max(files.length, Math.min(4, toolNames.length));
  for (let i = 0; i < steps; i++) {
    const f = files[i];
    const toolName = f?.toolName ?? toolNames[i % toolNames.length] ?? "Read";
    events.push({
      type: "tool_use",
      timestamp: new Date(start + span * (0.2 + 0.12 * i)).toISOString(),
      content: f ? `${toolName} ${f.path}` : `${toolName} call`,
      toolName,
      toolUseId: `demo-tool-${seed.id}-${i}`,
      durationMs: 800 + i * 250,
      toolInput: f ? { file_path: f.path } : undefined,
    });
  }

  if (seed.errorCount > 0) {
    events.push({
      type: "error",
      timestamp: new Date(start + span * 0.72).toISOString(),
      content: "A test failed on the first attempt; adjusted the edge case and re-ran.",
    });
  }

  events.push({
    type: "assistant",
    timestamp: new Date(end).toISOString(),
    content: seed.lastRecap ?? "Change applied and verified.",
    tokenCount: 1120,
  });

  return events;
}

function buildFileOperations(seed: SessionSeed, nowMs: number): FileOperation[] {
  const start = nowMs - seed.startOffset;
  const span = Math.max(1, seed.durationMs);
  return (seed.files ?? []).map((f, i) => ({
    path: f.path,
    operation: f.operation,
    toolName: f.toolName,
    timestamp: new Date(start + span * (0.25 + 0.1 * i)).toISOString(),
  }));
}

function buildSubagents(seed: SessionSeed, nowMs: number): SubagentInfo[] {
  const specs = seed.subagents ?? [];
  const start = nowMs - seed.startOffset;
  const span = Math.max(1, seed.durationMs);
  return specs.map((s, i) => {
    const first = new Date(start + span * (0.2 + 0.15 * i)).toISOString();
    const last = new Date(start + span * (0.3 + 0.15 * i)).toISOString();
    return {
      agentId: `demo-sub-${seed.id}-${i}`,
      type: s.type,
      description: s.description,
      messageCount: 12 + i * 4,
      toolUsage: { Read: 6 + i, Grep: 3, Bash: 2 },
      category: s.type === "code-reviewer" ? "check" : "research",
      metaTurnCount: 8 + i * 2,
      metaSourced: false,
      totalTokens: 42_000 + i * 8_000,
      model: i % 2 === 0 ? SONNET : HAIKU,
      durationMs: 90_000 + i * 30_000,
      firstTimestamp: first,
      lastTimestamp: last,
    };
  });
}

/**
 * Coherent single-session detail for any id (or slug) in `demoSessionsList`,
 * wrapped as a `SessionDetailResult` to match `resolveSessionDetail()`. Unknown
 * ids fall back to the first (freshest) session so the route never throws /
 * 404s in demo mode.
 */
export function demoSessionDetail(idOrSlug: string, nowMs: number): SessionDetailResult {
  const seed =
    SEEDS.find((s) => s.id === idOrSlug || s.slug === idOrSlug) ??
    SEEDS.slice().sort((a, b) => a.startOffset - b.startOffset)[0];

  const summary = toSummary(seed, nowMs);
  const detail: SessionDetail = {
    ...summary,
    timeline: buildTimeline(seed, nowMs),
    fileOperations: buildFileOperations(seed, nowMs),
    subagents: buildSubagents(seed, nowMs),
  };
  return { detail, meta: { backend: "file" } };
}
