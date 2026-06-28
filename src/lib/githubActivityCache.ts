import { execFile } from "child_process";
import { runGit, detectMainBranch } from "./scanner/git";
import { parseGitHubRemote } from "./githubRemote";
import type {
  GithubActivity,
  GithubActivityReason,
  GithubCiStatus,
  GithubPrSummary,
} from "./types";

/**
 * GitHub Activity Cache (Portfolio Command Deck — Phase 4)
 *
 * A `globalThis` singleton that mirrors `gitStatusCache` exactly: a queue, a
 * `seen` dedupe set, a `generation` counter for `dispose()` race protection,
 * batched `processQueue` with `BATCH_SIZE`/`BATCH_DELAY`, a 5-min TTL, and
 * `get`/`getAll`/`pending`/`total`/`dispose` accessors. Enqueued by
 * `GET /api/projects` (flag-gated) and read by `GET /api/github-activity`.
 *
 * Each repo costs up to three `gh` round-trips (open PRs, latest default-branch
 * run, repo metadata), so the cadence is gentler than git-status (P6). The
 * whole surface is fully defensive: a missing/unauthenticated `gh`, a
 * non-GitHub remote, or a non-repo directory degrades to a cached
 * `available:false` sentinel with a `reason` — it never throws, never blocks a
 * scan, and (because the unavailable result is cached too) never re-shells a
 * `gh`-less or non-GitHub repo until the TTL lapses.
 *
 * Security (P2): `gh` is invoked via `execFile("gh", [array, args])` — never a
 * shell string. The `owner/repo` passed as `-R` is validated by
 * `parseGitHubRemote` against `^[A-Za-z0-9._-]+$`, so a malformed remote can't
 * smuggle a flag or shell metacharacter.
 */

interface QueueItem {
  slug: string;
  path: string;
  remoteUrl?: string;
}

const CACHE_TTL = 5 * 60_000; // 5 minutes — matches gitStatusCache + scan cache
const BATCH_SIZE = 2; // gentler than git-status: up to 3 gh round-trips/repo (P6)
const BATCH_DELAY = 800; // ms between batches
const PR_LIMIT = 20; // cap the PR list payload
const GH_TIMEOUT = 8_000; // ms per gh call — never hang a poll
const GH_MAX_BUFFER = 8 * 1024 * 1024; // 8 MB — bound a pathological PR list

// ── gh --json response shapes (only the fields we request) ──────────────────
interface GithubPrApi {
  number: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  headRefName?: string;
  updatedAt?: string;
}
interface GithubRunApi {
  status?: string;
  conclusion?: string | null;
  workflowName?: string;
  url?: string;
}
interface GithubRepoApi {
  pushedAt?: string;
}

interface GhError {
  code: string | number | undefined;
  stderr: string;
}
interface GhResult<T> {
  data?: T;
  error?: GhError;
}

/**
 * Runs `gh <args>` in `cwd` and JSON-parses stdout. Never rejects: a spawn
 * error (ENOENT), a non-zero exit, a timeout, or non-JSON stdout all resolve
 * to `{ error }`. Uses `execFile` with an **array** of args (no shell).
 */
function ghJson<T>(args: string[], cwd: string): Promise<GhResult<T>> {
  return new Promise((resolve) => {
    try {
      execFile(
        "gh",
        args,
        { cwd, timeout: GH_TIMEOUT, windowsHide: true, maxBuffer: GH_MAX_BUFFER },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            resolve({
              error: { code, stderr: String(stderr || err.message || "") },
            });
            return;
          }
          try {
            resolve({ data: JSON.parse(stdout) as T });
          } catch {
            resolve({ error: { code: "PARSE", stderr: "non-JSON output from gh" } });
          }
        }
      );
    } catch {
      // execFile itself threw synchronously (extremely unlikely) — stay defensive.
      resolve({ error: { code: "SPAWN", stderr: "failed to spawn gh" } });
    }
  });
}

/** Map a `gh` failure to a quiet, specific unavailable reason. */
function classifyGhError(
  error: GhError,
  repo: string
): Omit<GithubActivity, "checkedAt"> {
  let reason: GithubActivityReason = "error";
  if (error.code === "ENOENT") {
    reason = "gh-not-installed";
  } else {
    const s = error.stderr || "";
    if (/gh auth login|not logged in|authentication|HTTP 401|requires authentication/i.test(s)) {
      reason = "unauthenticated";
    } else if (
      /could not resolve to a Repository|HTTP 404|not a git repository|no such repository/i.test(s)
    ) {
      reason = "not-a-github-repo";
    }
  }
  return { available: false, reason, repo };
}

/** Map a workflow run's status/conclusion to a coarse CI status. */
function mapCi(run: GithubRunApi): {
  status: GithubCiStatus;
  workflowName?: string;
  url?: string;
} {
  let status: GithubCiStatus = "unknown";
  const c = run.conclusion;
  const st = run.status;
  if (c === "success") {
    status = "passing";
  } else if (
    c &&
    ["failure", "timed_out", "cancelled", "startup_failure", "action_required"].includes(c)
  ) {
    status = "failing";
  } else if (
    st &&
    ["in_progress", "queued", "requested", "waiting", "pending"].includes(st)
  ) {
    status = "pending";
  }
  return {
    status,
    workflowName: run.workflowName || undefined,
    url: run.url || undefined,
  };
}

function toPrSummary(pr: GithubPrApi): GithubPrSummary {
  return {
    number: pr.number,
    title: pr.title ?? "",
    url: pr.url ?? "",
    isDraft: !!pr.isDraft,
    headRefName: pr.headRefName ?? "",
    updatedAt: pr.updatedAt ?? "",
  };
}

/**
 * Fetch open PRs / latest default-branch CI / last-push for one repo. Fully
 * defensive; returns a `GithubActivity` minus `checkedAt` (the cache stamps it).
 */
async function fetchActivity(
  item: QueueItem
): Promise<Omit<GithubActivity, "checkedAt">> {
  // Resolve owner/repo from the supplied remote, else ask git once.
  let remote = item.remoteUrl;
  if (!remote) {
    remote = (await runGit(["remote", "get-url", "origin"], item.path)) || undefined;
    if (!remote) return { available: false, reason: "no-remote" };
  }

  const ref = parseGitHubRemote(remote);
  if (!ref) return { available: false, reason: "not-a-github-repo" }; // P5: no spawn

  const repo = `${ref.owner}/${ref.repo}`;
  const R = ["-R", repo]; // safe: ref segments are [A-Za-z0-9._-] only (P2)

  // Open PRs first — its failure classifies the whole result (gh missing/auth).
  const prs = await ghJson<GithubPrApi[]>(
    [
      "pr",
      "list",
      ...R,
      "--state",
      "open",
      "--limit",
      String(PR_LIMIT),
      "--json",
      "number,title,url,isDraft,headRefName,updatedAt",
    ],
    item.path
  );
  if (prs.error) return classifyGhError(prs.error, repo);

  // CI + last-push are best-effort enrichments — a failure of either (e.g. no
  // Actions configured ⇒ empty run list) must not blank the PR data.
  const defaultBranch = (await detectMainBranch(item.path)) || "main";
  const runs = await ghJson<GithubRunApi[]>(
    [
      "run",
      "list",
      ...R,
      "--branch",
      defaultBranch,
      "--limit",
      "1",
      "--json",
      "status,conclusion,workflowName,url",
    ],
    item.path
  );
  const repoMeta = await ghJson<GithubRepoApi>(
    ["repo", "view", ...R, "--json", "pushedAt"],
    item.path
  );

  return {
    available: true,
    repo,
    openPrCount: prs.data?.length ?? 0,
    prs: (prs.data ?? []).map(toPrSummary),
    ci: runs.data && runs.data[0] ? mapCi(runs.data[0]) : { status: "unknown" },
    lastPushAt: repoMeta.data?.pushedAt,
  };
}

class GithubActivityCache {
  private cache = new Map<string, GithubActivity>();
  private queue: QueueItem[] = [];
  private running = false;
  private seen = new Set<string>(); // prevent duplicate queue entries per cycle
  // Items pulled off `queue` whose `gh` calls are still resolving. Counted into
  // `pending` so the UI doesn't stop polling mid-batch: a batch is spliced out
  // of `queue` *before* the (up to 3 sequential, 8s-timeout) gh calls finish,
  // so without this `pending` would read 0 while results are still in flight.
  private inFlight = 0;
  // Bumped by dispose(); processQueue() snapshots it at start and drops any
  // awaited results that landed after a dispose() — mirrors gitStatusCache.
  private generation = 0;

  enqueue(projects: QueueItem[]) {
    for (const p of projects) {
      const cached = this.cache.get(p.slug);
      // available:false results are cached too — don't re-shell a gh-less or
      // non-GitHub repo every poll until TTL expires.
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL) continue;
      if (this.seen.has(p.slug)) continue;

      this.seen.add(p.slug);
      this.queue.push(p);
    }

    if (!this.running && this.queue.length > 0) {
      this.running = true;
      void this.processQueue();
    }
  }

  private async processQueue() {
    const myGen = this.generation;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);
      this.inFlight += batch.length;

      let results: { slug: string; activity: Omit<GithubActivity, "checkedAt"> }[];
      try {
        results = await Promise.all(
          batch.map(async (item) => {
            try {
              const activity = await fetchActivity(item);
              return { slug: item.slug, activity };
            } catch {
              // fetchActivity is internally defensive, but stay belt-and-suspenders.
              return {
                slug: item.slug,
                activity: { available: false, reason: "error" as const },
              };
            }
          })
        );
      } finally {
        // Release the in-flight credit — unless dispose() already zeroed the
        // counter for a newer generation (avoids driving inFlight negative).
        if (myGen === this.generation) this.inFlight -= batch.length;
      }

      // Drop the batch if dispose() ran while we were awaiting.
      if (myGen !== this.generation) return;

      for (const { slug, activity } of results) {
        this.cache.set(slug, { ...activity, checkedAt: Date.now() });
      }

      if (this.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    this.running = false;
    this.seen.clear();
  }

  get(slug: string): GithubActivity | null {
    const entry = this.cache.get(slug);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > CACHE_TTL) return null;
    return entry;
  }

  getAll(): Record<string, GithubActivity> {
    const result: Record<string, GithubActivity> = {};
    for (const [slug, entry] of this.cache) {
      if (Date.now() - entry.checkedAt < CACHE_TTL) {
        result[slug] = entry;
      }
    }
    return result;
  }

  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  get total(): number {
    return this.cache.size;
  }

  /** Drain the queue, forget cached activity, and invalidate any in-flight
   *  processQueue() batch (generation bump). Used by the feature-flag
   *  hot-toggle path. */
  dispose() {
    this.generation++;
    this.queue.length = 0;
    this.seen.clear();
    this.cache.clear();
    this.running = false;
    this.inFlight = 0;
  }
}

// Singleton — persist across hot reloads in dev.
const globalForGAC = globalThis as unknown as {
  __githubActivityCache?: GithubActivityCache;
};
export const githubActivityCache =
  globalForGAC.__githubActivityCache ||
  (globalForGAC.__githubActivityCache = new GithubActivityCache());
