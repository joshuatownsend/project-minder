// ── GitHub activity (Portfolio Command Deck — Phase 4) ──────────────────────
// Surfaced per project from the local authenticated `gh` CLI by
// `githubActivityCache` and served over GET /api/github-activity. Fully
// defensive: a missing/unauthenticated `gh`, a non-GitHub remote, or a
// non-repo directory degrades to `available:false` with a `reason` so the UI
// can stay quiet instead of erroring.

export type GithubActivityReason =
  | "gh-not-installed"      // execFile ENOENT
  | "unauthenticated"       // gh exited with an auth error
  | "not-a-github-repo"     // remote isn't github.com (decided before spawning gh)
  | "no-remote"             // no origin remote at all
  | "error";                // any other gh/parse failure

export type GithubCiStatus = "passing" | "failing" | "pending" | "unknown";

export interface GithubPrSummary {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  updatedAt: string;        // ISO
}

export interface GithubActivity {
  available: boolean;       // false ⇒ render nothing; `reason` says why
  reason?: GithubActivityReason;
  repo?: string;            // "owner/repo" when resolvable
  openPrCount?: number;
  prs?: GithubPrSummary[];  // capped (PR_LIMIT)
  ci?: { status: GithubCiStatus; workflowName?: string; url?: string };
  lastPushAt?: string;      // ISO — repo.pushedAt
  checkedAt: number;        // epoch ms — drives TTL (set even when available:false)
}
