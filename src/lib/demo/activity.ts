import type { GithubActivity, McpHealth } from "@/lib/types";
// quota.ts is `server-only`; import the TYPE only so this module stays importable
// from route handlers without pulling the server-only runtime in.
import type { QuotaData } from "@/lib/quota";

/**
 * Synthetic activity-strip fixtures for demo mode — the four background caches
 * behind the dashboard's live strips (GitHub activity, git dirty-status, MCP
 * health, and the quota burn HUD). Deterministic (no randomness); every
 * timestamp is anchored to a `nowMs` passed at request time with a FIXED offset,
 * so relative times stay fresh while the payload is byte-stable. Served from a
 * `demoMode()` guard at the top of each route, bypassing the real cache.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO timestamp `offsetMs` in the past relative to `nowMs`. */
function iso(nowMs: number, offsetMs: number): string {
  return new Date(nowMs - offsetMs).toISOString();
}

// ── GitHub activity ─────────────────────────────────────────────────────────
// Keyed by project ROUTE slug. Only the demo projects with a git remote appear
// (aurora-commerce, pulse-analytics, quill-cms, ledger-api, beacon-mobile) —
// atlas-cli / synth-playground / archive-legacy-dash have no remote, matching
// `demoProjects`.

/** Live GitHub activity per project, keyed by route slug. */
export function demoGithubActivity(nowMs: number): Record<string, GithubActivity> {
  return {
    "aurora-commerce": {
      available: true,
      repo: "acme/aurora-commerce",
      openPrCount: 2,
      prs: [
        {
          number: 412,
          title: "feat: idempotent stripe webhook handler",
          url: "https://github.com/acme/aurora-commerce/pull/412",
          isDraft: false,
          headRefName: "feat/checkout-webhook",
          updatedAt: iso(nowMs, 40 * MIN),
        },
        {
          number: 409,
          title: "wip: optimistic cart drawer",
          url: "https://github.com/acme/aurora-commerce/pull/409",
          isDraft: true,
          headRefName: "feat/cart-drawer",
          updatedAt: iso(nowMs, 5 * HOUR),
        },
      ],
      ci: {
        status: "passing",
        workflowName: "CI",
        url: "https://github.com/acme/aurora-commerce/actions/runs/900412",
      },
      lastPushAt: iso(nowMs, 40 * MIN),
      checkedAt: nowMs - 30_000,
    },
    "pulse-analytics": {
      available: true,
      repo: "acme/pulse-analytics",
      openPrCount: 0,
      prs: [],
      ci: {
        status: "passing",
        workflowName: "CI",
        url: "https://github.com/acme/pulse-analytics/actions/runs/771233",
      },
      lastPushAt: iso(nowMs, 5 * HOUR),
      checkedAt: nowMs - 45_000,
    },
    "quill-cms": {
      available: true,
      repo: "acme/quill-cms",
      openPrCount: 1,
      prs: [
        {
          number: 88,
          title: "feat: drag-drop media grid",
          url: "https://github.com/acme/quill-cms/pull/88",
          isDraft: true,
          headRefName: "feat/media-library",
          updatedAt: iso(nowMs, 26 * HOUR),
        },
      ],
      ci: {
        status: "failing",
        workflowName: "CI",
        url: "https://github.com/acme/quill-cms/actions/runs/33120",
      },
      lastPushAt: iso(nowMs, 26 * HOUR),
      checkedAt: nowMs - 60_000,
    },
    "ledger-api": {
      available: true,
      repo: "acme/ledger-api",
      openPrCount: 0,
      prs: [],
      ci: {
        status: "pending",
        workflowName: "CI",
        url: "https://github.com/acme/ledger-api/actions/runs/55201",
      },
      lastPushAt: iso(nowMs, 2 * DAY),
      checkedAt: nowMs - 90_000,
    },
    "beacon-mobile": {
      available: true,
      repo: "acme/beacon-mobile",
      openPrCount: 3,
      prs: [
        {
          number: 141,
          title: "feat: expo push token registration",
          url: "https://github.com/acme/beacon-mobile/pull/141",
          isDraft: false,
          headRefName: "feat/push-notifications",
          updatedAt: iso(nowMs, 4 * HOUR),
        },
        {
          number: 138,
          title: "fix: android deep-link cold start",
          url: "https://github.com/acme/beacon-mobile/pull/138",
          isDraft: false,
          headRefName: "fix/deep-link",
          updatedAt: iso(nowMs, 28 * HOUR),
        },
        {
          number: 133,
          title: "chore: bump expo sdk to 52",
          url: "https://github.com/acme/beacon-mobile/pull/133",
          isDraft: true,
          headRefName: "chore/expo-52",
          updatedAt: iso(nowMs, 3 * DAY),
        },
      ],
      ci: {
        status: "passing",
        workflowName: "EAS Build",
        url: "https://github.com/acme/beacon-mobile/actions/runs/98122",
      },
      lastPushAt: iso(nowMs, 4 * HOUR),
      checkedAt: nowMs - 20_000,
    },
  };
}

// ── Git dirty status ────────────────────────────────────────────────────────
// Keyed by route slug. Counts match `demoProjects` uncommittedCount so the card
// `+N` badges agree with the project fixtures.

/** Structural mirror of `gitStatusCache`'s private `DirtyStatus` (its `getAll()`
 *  return element). Redeclared here because the cache doesn't export it. */
interface DemoDirtyStatus {
  isDirty: boolean;
  uncommittedCount: number;
  checkedAt: number;
  unknown?: boolean;
}

/** Git dirty status per project, keyed by route slug. */
export function demoGitStatus(nowMs: number): Record<string, DemoDirtyStatus> {
  const counts: Record<string, number> = {
    "aurora-commerce": 7,
    "pulse-analytics": 0,
    "quill-cms": 3,
    "ledger-api": 0,
    "atlas-cli": 0,
    "beacon-mobile": 12,
    "synth-playground": 1,
    "archive-legacy-dash": 0,
  };
  const checkedAt = nowMs - 15_000;
  const out: Record<string, DemoDirtyStatus> = {};
  for (const [slug, uncommittedCount] of Object.entries(counts)) {
    out[slug] = { isDirty: uncommittedCount > 0, uncommittedCount, checkedAt };
  }
  return out;
}

// ── MCP health ──────────────────────────────────────────────────────────────
// Keyed by a `serverIdentity`-style composite (source + path + name) so the
// strip can disambiguate same-name servers. A mix of transports, sources, and
// up/down/unknown verdicts.

interface McpSeed {
  key: string;
  health: McpHealth;
}

// NUL separator, matching `mcpHealthCache.serverIdentity`. Built from plain text
// (never a literal NUL byte) so Git doesn't classify this source as binary.
const SEP = String.fromCharCode(0);

/** Fixed placeholder probe time. `demoMcpHealth` takes no `nowMs` (the route
 *  serves it directly, bypassing the TTL-driven cache path), so `checkedAt`
 *  can't be anchored to now; a caller that wants a fresh stamp may pass one. */
const DEMO_MCP_CHECKED_AT = 1_700_000_000_000;

/** Live MCP-server health, keyed by server identity. Optional `nowMs` lets a
 *  route anchor `checkedAt`; omitted, it falls back to a fixed constant so the
 *  fixture stays deterministic. */
export function demoMcpHealth(nowMs?: number): Record<string, McpHealth> {
  const checkedAt = nowMs ?? DEMO_MCP_CHECKED_AT;
  const seeds: McpSeed[] = [
    {
      key: `user${SEP}C:\\Users\\demo\\.claude.json${SEP}project-minder`,
      health: {
        name: "project-minder",
        transport: "http",
        source: "user",
        status: "up",
        detail: "reachable (HTTP 200)",
        probeKind: "http",
        checkedAt,
      },
    },
    {
      key: `user${SEP}C:\\Users\\demo\\.claude.json${SEP}github`,
      health: {
        name: "github",
        transport: "stdio",
        source: "user",
        status: "up",
        detail: "command resolves (gh)",
        probeKind: "command",
        checkedAt,
      },
    },
    {
      key: `project${SEP}C:\\dev\\aurora-commerce\\.mcp.json${SEP}stripe`,
      health: {
        name: "stripe",
        transport: "http",
        source: "project",
        status: "down",
        detail: "unreachable (fetch failed)",
        probeKind: "http",
        checkedAt,
      },
    },
    {
      key: `user${SEP}C:\\Users\\demo\\.claude.json${SEP}supabase`,
      health: {
        name: "supabase",
        transport: "sse",
        source: "user",
        status: "up",
        detail: "reachable (HTTP 200)",
        probeKind: "http",
        checkedAt,
      },
    },
    {
      key: `plugin${SEP}C:\\Users\\demo\\.claude\\plugins\\context-mode${SEP}context-mode`,
      health: {
        name: "context-mode",
        transport: "stdio",
        source: "plugin",
        status: "unknown",
        detail: "not probed (disabled)",
        probeKind: "none",
        checkedAt,
      },
    },
  ];
  const out: Record<string, McpHealth> = {};
  for (const s of seeds) out[s.key] = s.health;
  return out;
}

// ── Quota (burn HUD) ────────────────────────────────────────────────────────

/** A configured quota so the burn HUD renders with plausible utilizations and
 *  reset times anchored to `nowMs`. */
export function demoQuota(nowMs: number): QuotaData {
  const fiveHReset = Math.floor((nowMs + 3 * HOUR + 12 * MIN) / 1000);
  const sevenDReset = Math.floor((nowMs + 4 * DAY + 6 * HOUR) / 1000);
  const overageReset = Math.floor((nowMs + 3 * HOUR + 12 * MIN) / 1000);
  return {
    configured: true,
    subscriptionType: "max",
    rateLimitTier: "default",
    overallStatus: "allowed",
    representativeClaim: "five_hour",
    fallbackPercentage: 0,
    windows: {
      "5h": {
        utilization: 0.34,
        status: "allowed",
        reset: fiveHReset,
        resetAt: new Date(fiveHReset * 1000).toISOString(),
      },
      "7d": {
        utilization: 0.52,
        status: "allowed",
        reset: sevenDReset,
        resetAt: new Date(sevenDReset * 1000).toISOString(),
      },
      overage: {
        utilization: 0,
        status: "allowed",
        reset: overageReset,
        resetAt: new Date(overageReset * 1000).toISOString(),
      },
    },
    cachedAt: iso(nowMs, 30_000),
  };
}
