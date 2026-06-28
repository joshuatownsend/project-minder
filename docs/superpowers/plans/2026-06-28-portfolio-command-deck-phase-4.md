# Portfolio Command Deck — Phase 4 Implementation Plan (GitHub activity surface)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parent plan:** This is the task-by-task implementation of **Phase 4** of `docs/superpowers/plans/2026-06-25-portfolio-command-deck.md` (the roadmap, §7 "Phase 4 — GitHub activity surface"). The roadmap locks the *decisions*; this doc locks the *tasks, files, and code*. When in conflict, the roadmap's data model wins over any convenience shape; **the live codebase wins over the roadmap on mechanics** (the `gitStatusCache` enqueue/poll substrate and the `prExtractor`/`ticketExtractor` PR-link surface are both merged — this phase mirrors them).

**Goal:** Surface, per project, the three things that make you switch to a GitHub tab — **open PRs**, **CI pass/fail**, and **how long ago the last push was** — directly on the dashboard card and the project detail page, without leaving Minder (the Plane "in-pane" win the roadmap calls out). The data comes from the **`gh` CLI** the user already has authenticated, fetched in a background, batched, TTL'd cache that mirrors `gitStatusCache` exactly, and polled by the client the same way `/api/git-status` is. The whole surface is **fully defensive**: a missing/unauthenticated `gh`, a non-GitHub remote, or a non-repo directory degrades to a quiet "unavailable" state and **never throws, never blocks a scan, and never spams the user**.

**Architecture:** This phase is **a new background cache + one read route + a card/detail strip** — structurally a clone of the already-shipped git-status pipeline. `gitStatusCache.ts` is the template: a `globalThis` singleton holding a `Map<slug, …>`, a `queue`, a `seen` dedupe set, a `generation` counter for `dispose()` invalidation, `enqueue()`/`processQueue()` with `BATCH_SIZE`/`BATCH_DELAY`, a 5-min `CACHE_TTL`, and `get`/`getAll`/`pending`/`total` accessors. `GET /api/git-status` is the template route (`getAll()` + `pending` + `total`); `useGitDirtyStatus` is the template client hook (poll every 5s, stop when `pending===0 && total>0`, cooldown'd error toast); `enrichAndEnqueue` in `GET /api/projects` is the template enqueue site. The **only genuinely new** mechanics are (1) shelling out to `gh` via `child_process` with **array args** (never string-interpolated), (2) parsing `owner/repo` out of the git remote (a small pure, tested helper), and (3) the defensive classification of `gh` failure modes into a small reason enum so the UI can stay silent instead of erroring. Cross-linking sessions↔PRs **reuses** the existing `PrLink` surface (`prExtractor` already harvests `{url, number, repo}` per session into both backends) — no new extraction.

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, Vitest, `child_process` (`execFile`) for `gh`. Package manager: **pnpm**. Verification gate per `CLAUDE.md`: `pnpm typecheck` + full `pnpm test --pool=forks` (report exact pass count), and `pnpm build` for the route + UI strip.

---

## Decisions baked into this plan

| # | Decision | Rationale |
|---|----------|-----------|
| P1 | **Mirror `gitStatusCache` 1:1** — `globalThis` singleton, `queue`/`seen`/`generation`, batched `processQueue`, 5-min TTL, `get`/`getAll`/`pending`/`total`/`dispose`. | The git-status pipeline is proven, tested (`tests/gitStatusCacheDispose.test.ts`), and already understood by the dashboard. A parallel cache (not a generalization of the existing one) keeps the two independent and avoids a risky refactor of a hot path. |
| P2 | **Shell `gh` via `execFile("gh", [args])` — array args, NEVER a shell string.** `owner`/`repo` are validated against `^[A-Za-z0-9._-]+$` before being passed as `-R <owner>/<repo>`. | Security gate from the task brief: untrusted values (remote URLs from arbitrary repos) must never be interpolated into a shell. `execFile` with an args array bypasses the shell entirely; the regex validation is belt-and-suspenders so a malformed remote can't smuggle a flag. |
| P3 | **Resolve `owner/repo` from the git remote, with a pure tested parser.** `parseGitHubRemote(remoteUrl)` handles `git@github.com:owner/repo.git`, `https://github.com/owner/repo(.git)`, and `ssh://git@github.com/owner/repo`. Non-`github.com` hosts → `null`. | The roadmap says "resolve repo from git remote." `ProjectData.git.remoteUrl` is **already computed** by `scanGit` (SSH→HTTPS normalized), so the enqueue payload can carry it and the cache avoids a redundant `git` subprocess. The cache falls back to `git remote get-url origin` only if no `remoteUrl` was supplied. A pure parser is unit-testable against weird inputs without spawning `gh`. |
| P4 | **Three `gh` calls per repo, classified, capped, fully defensive — never throw.** `gh pr list --state open --json …`, `gh run list --branch <default> --limit 1 --json …`, `gh repo view --json pushedAt,defaultBranchRef`. Every failure is caught and mapped to a `reason` enum (`gh-not-installed` \| `unauthenticated` \| `not-a-github-repo` \| `no-remote` \| `error`). | Keeps to the roadmap's "gh CLI, not Octokit" scope (Octokit/GraphQL is the Phase-5 D3 scale-up). Capping PRs (default 20) and limiting runs to 1-on-default-branch bounds the payload. Classification lets the UI render a quiet, *specific* unavailable state (and lets the cache stop retrying a permanently-non-GitHub repo) instead of a generic error. **`available:false` is still a cached result** — it counts toward TTL so we don't re-shell a `gh`-less machine every poll. |
| P5 | **`reason: "not-a-github-repo"` is decided *before* spawning `gh`** — if `parseGitHubRemote` returns `null`, cache the unavailable sentinel without a subprocess. | ~60 repos, most may be GitHub but some are local-only or GitLab. Skipping the spawn for a non-GitHub remote is the cheapest possible path and avoids a guaranteed-useless `gh` error per non-GitHub repo on every refresh. |
| P6 | **Smaller batch, longer delay than git-status** (`BATCH_SIZE = 2`, `BATCH_DELAY = 800ms`), and the **flag gate lives at the enqueue site**. | `gh` does 3 network round-trips per repo and shares the user's GitHub REST rate budget; the roadmap flags this as the likely Phase-4→GraphQL trigger (§9). A gentler cadence is the cheap mitigation. The gate at `enrichAndEnqueue` (mirroring how `gitStatusCache` is enqueued from the route, **not** the scanner orchestrator) means the flag is `wired: true` from day one. |
| P7 | **Cross-link sessions↔PRs reuses `PrLink`, best-effort, read-only.** The detail strip joins each open PR (`repo`+`number`) against the project's session `prLinks` (already in the index via `prExtractor`) to show "opened in session …". No match → just the PR. | The brief says "reuse the existing `PrLink`/`TicketLink` extraction to cross-link." `PrLink` already carries `{repo:"owner/repo", number}`, which is the exact join key against `gh pr list`'s `{headRepository…, number}`. This is a presentation join, not new scanning — so it's UI-tier and can't regress the cache. |
| P8 | **Feature flag `githubActivity`, default-on, neutral-when-off.** Off ⇒ the route returns an empty `statuses` map, the enqueue is skipped, and the strip renders nothing. | Matches every other cache/scanner per `featureFlags.ts`. Default-on because a `gh`-less user already degrades to a silent unavailable state (P4), so default-on costs nothing for users without `gh`. |

**Suggested PR boundaries** (each independently green under the verification gate):
- **PR 1 — Data layer** (Group A): types + flag, `parseGitHubRemote` + tests, `githubActivityCache` + tests, `GET /api/github-activity`. No UI, no enqueue wiring yet — the route returns an empty map until PR 2 enqueues. Self-contained and fully unit-tested.
- **PR 2 — Wiring + UI** (Group B): flag-gated enqueue in `GET /api/projects`, `useGithubActivity` hook, the card strip, the detail strip + session↔PR cross-link.
- **PR 3 — Docs + verification** (Group C): `docs/help/github-activity.md` (+ mirror) + `help-mapping` + `HelpPanel`, CHANGELOG, CLAUDE.md, final gate.

---

# Group A — Data layer (PR 1)

> Outcome: a `githubActivityCache` singleton fetches open PRs / CI status / last-push per project via `gh`, fully defensively, and `GET /api/github-activity` serves it exactly like `/api/git-status`. Everything here is unit-tested with `gh` and `git` mocked.

### Task A1: Types + feature flag

**Files:**
- Modify: `src/lib/types.ts` (add the `GithubActivity` shape + the `githubActivity` flag-union member)
- Modify: `src/lib/featureFlags.ts` (`FEATURE_FLAG_KEYS` + `FEATURE_FLAG_META`)
- Modify: `tests/featureFlags.test.ts` (the meta-coverage test auto-asserts the new key; confirm it stays green and the `>= 12` floor still holds)

- [ ] **Step 1: Types.** Add to `src/lib/types.ts` (near `PrLink`, the related cross-link surface):

```typescript
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
```

- [ ] **Step 2: Flag.** Add `"githubActivity"` to the `FeatureFlagKey` union in `types.ts`, to `FEATURE_FLAG_KEYS` in `featureFlags.ts`, and a `FEATURE_FLAG_META` entry:

```typescript
{
  key: "githubActivity",
  label: "GitHub activity",
  description: "Background `gh` fetch of open PRs, CI status, and last push per project (drives the GitHub strip on cards + detail).",
  group: "active",
  appliesAt: "watcher",
  wired: true,
},
```

- [ ] **Step 3:** Run `pnpm test tests/featureFlags.test.ts` — the "covers every FeatureFlagKey exactly once" and "matches the FeatureFlagKey union" tests must stay green automatically. (No new assertion needed; the meta map is the single source the test reads.)
- [ ] **Step 4: Verify + Commit** — `feat(github): GithubActivity types + githubActivity feature flag`

---

### Task A2: `parseGitHubRemote` pure helper

**Files:**
- Create: `src/lib/githubRemote.ts`
- Create: `tests/githubRemote.test.ts`
- Reference (do not duplicate, but mirror the SSH→HTTPS shapes it already handles): `src/lib/scanner/git.ts` lines ~130–141.

- [ ] **Step 1:** A pure parser that extracts `{owner, repo}` from a remote URL, returning `null` for anything that isn't a `github.com` HTTPS/SSH remote. `owner`/`repo` are validated against `^[A-Za-z0-9._-]+$` so the result is safe to pass to `execFile` as `-R owner/repo` (P2):

```typescript
export interface GithubRepoRef { owner: string; repo: string; }

const SEG = "[A-Za-z0-9._-]+";

// Accept: https://github.com/o/r(.git), git@github.com:o/r(.git),
// ssh://git@github.com/o/r(.git). Reject non-github hosts and any
// segment with a slash/colon/space.
export function parseGitHubRemote(remoteUrl: string | undefined | null): GithubRepoRef | null {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim();

  const https = url.match(new RegExp(`^https?://github\\.com/(${SEG})/(${SEG}?)(?:\\.git)?/?$`));
  const sshScp = url.match(new RegExp(`^git@github\\.com:(${SEG})/(${SEG}?)(?:\\.git)?/?$`));
  const sshUrl = url.match(new RegExp(`^ssh://git@github\\.com/(${SEG})/(${SEG}?)(?:\\.git)?/?$`));

  const m = https ?? sshScp ?? sshUrl;
  if (!m) return null;
  const owner = m[1];
  const repo = (m[2] ?? "").replace(/\.git$/, "");
  if (!owner || !repo) return null;
  // Belt-and-suspenders: reject anything the capture groups shouldn't allow.
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}
```

- [ ] **Step 2: tests** (`tests/githubRemote.test.ts`) — cover: HTTPS with/without `.git` and trailing slash; SCP-style `git@github.com:o/r.git`; `ssh://` form; a repo name with a dot (`o/my.repo`); GitLab/Bitbucket/other hosts → `null`; empty/undefined/garbage → `null`; an attempted-injection remote like `https://github.com/o/r;rm -rf` → `null` (the `;` / space fails the segment class). This is the security-critical unit — hammer it.
- [ ] **Step 3: Verify + Commit** — `feat(github): parseGitHubRemote — safe owner/repo extraction from a git remote`

---

### Task A3: `githubActivityCache` singleton

**Files:**
- Create: `src/lib/githubActivityCache.ts`
- Create: `tests/githubActivityCache.test.ts`
- Reference (mirror structure exactly): `src/lib/gitStatusCache.ts` (singleton/queue/seen/generation/dispose, `BATCH_SIZE`/`BATCH_DELAY`/`CACHE_TTL`, `get`/`getAll`/`pending`/`total`), `tests/gitStatusCacheDispose.test.ts` (generation/dispose test pattern), `src/lib/scanner/git.ts` (`runGit`, `resolveDefaultBranch` — reuse, do not re-implement).

- [ ] **Step 1: The queue item + the fetcher.** The enqueue payload carries the already-computed remote so the common path needs **no** extra `git` call (P3):

```typescript
interface QueueItem { slug: string; path: string; remoteUrl?: string; }

const CACHE_TTL = 5 * 60_000;   // 5 minutes — matches gitStatusCache + scan cache
const BATCH_SIZE = 2;           // gentler than git-status: 3 gh round-trips/repo (P6)
const BATCH_DELAY = 800;        // ms between batches
const PR_LIMIT = 20;            // cap the PR list payload
const GH_TIMEOUT = 8_000;       // ms per gh call — never hang a poll
```

- [ ] **Step 2: `fetchActivity(item)` — fully defensive, never throws.** Returns a `GithubActivity` (with `checkedAt` set by the caller):

```typescript
async function fetchActivity(item: QueueItem): Promise<Omit<GithubActivity, "checkedAt">> {
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

  // Each gh call is independently guarded — a failure of one (e.g. no Actions
  // configured ⇒ run list empty) must not blank the others.
  const prs = await ghJson<GithubPrApi[]>(["pr", "list", ...R, "--state", "open",
    "--limit", String(PR_LIMIT), "--json", "number,title,url,isDraft,headRefName,updatedAt"], item.path);
  if (prs.error) return classifyGhError(prs.error, repo); // gh missing/auth ⇒ unavailable

  const defaultBranch = (await resolveDefaultBranch(item.path)) || "main";
  const runs = await ghJson<GithubRunApi[]>(["run", "list", ...R, "--branch", defaultBranch,
    "--limit", "1", "--json", "status,conclusion,workflowName,url"], item.path);
  const repoMeta = await ghJson<GithubRepoApi>(["repo", "view", ...R,
    "--json", "pushedAt"], item.path);

  return {
    available: true,
    repo,
    openPrCount: prs.data?.length ?? 0,
    prs: (prs.data ?? []).map(toPrSummary),
    ci: runs.data && runs.data[0] ? mapCi(runs.data[0]) : { status: "unknown" },
    lastPushAt: repoMeta.data?.pushedAt,
  };
}
```

  - `ghJson<T>(args, cwd)` wraps `execFile("gh", args, { cwd, timeout: GH_TIMEOUT, windowsHide: true })` in a Promise, returns `{ data?: T, error?: { code, stderr } }`, and **JSON.parses inside a try/catch** (a non-JSON stdout ⇒ `error`). It never rejects.
  - `classifyGhError(error, repo)`: `code === "ENOENT"` ⇒ `gh-not-installed`; stderr matches `/gh auth login|not logged|authentication|HTTP 401/i` ⇒ `unauthenticated`; stderr matches `/could not resolve to a Repository|HTTP 404|not a git repository/i` ⇒ `not-a-github-repo`; else `error`. Always returns `{ available:false, reason, repo }`.
  - `mapCi(run)`: `conclusion === "success"` ⇒ `passing`; `conclusion in {failure,timed_out,cancelled,startup_failure}` ⇒ `failing`; `status in {in_progress,queued,requested,waiting}` ⇒ `pending`; else `unknown`. Carry `workflowName`/`url`.

- [ ] **Step 3: The cache class** — copy `GitStatusCache` verbatim in shape (the `enqueue`/`processQueue`/`generation`/`dispose` logic is identical; only the per-item work changes from `scanGitDirtyStatus` to `fetchActivity`, and the stored value type is `GithubActivity`). Keep the `seen` dedupe, the `myGen !== this.generation` drop-after-dispose guard, the `BATCH_DELAY` between batches, and `get`/`getAll` honoring `CACHE_TTL`. Export the `globalThis` singleton as `githubActivityCache` under key `__githubActivityCache`. **Crucially: store the `available:false` results too** (with `checkedAt`), so a `gh`-less or non-GitHub repo isn't re-shelled every poll until TTL expires.

- [ ] **Step 4: tests** (`tests/githubActivityCache.test.ts`) — mock `child_process.execFile` and `@/lib/scanner/git` (`runGit`, `resolveDefaultBranch`). Cover:
  - **happy path:** `gh` returns 2 open PRs + a successful run + `pushedAt` ⇒ `available:true`, `openPrCount:2`, `ci.status:"passing"`, `lastPushAt` set, `repo:"owner/repo"`.
  - **gh missing:** `execFile` yields `ENOENT` ⇒ `available:false, reason:"gh-not-installed"`, **and the result is cached** (a second `enqueue` of the same slug within TTL does not re-spawn — assert `execFile` call count).
  - **unauthenticated:** stderr `gh auth login` ⇒ `reason:"unauthenticated"`.
  - **non-GitHub remote:** `remoteUrl:"git@gitlab.com:o/r.git"` ⇒ `reason:"not-a-github-repo"` and **`execFile` never called** (P5).
  - **no remote:** no `remoteUrl` + `runGit` returns `""` ⇒ `reason:"no-remote"`, no `gh`.
  - **CI mapping:** `conclusion:"failure"` ⇒ `failing`; `status:"in_progress"`,`conclusion:null` ⇒ `pending`; empty run list ⇒ `unknown` (and still `available:true`).
  - **never throws:** a `gh` call whose stdout is non-JSON ⇒ `reason:"error"`, not a rejection.
  - **dispose/generation:** mirror `tests/gitStatusCacheDispose.test.ts` — a `dispose()` mid-flight drops the in-flight batch's writes.
  - **arg safety (regression for P2):** assert `execFile` is called with `"gh"` and an **array** whose `-R` value is exactly `owner/repo` (never a concatenated shell string).
- [ ] **Step 5: Verify + Commit** — `feat(github): githubActivityCache — background gh fetch (PRs, CI, last push), fully defensive`

---

### Task A4: `GET /api/github-activity`

**Files:**
- Create: `src/app/api/github-activity/route.ts`
- Reference (clone): `src/app/api/git-status/route.ts`.

- [ ] **Step 1:** Mirror the git-status route exactly:

```typescript
import { NextResponse } from "next/server";
import { githubActivityCache } from "@/lib/githubActivityCache";

export async function GET() {
  return NextResponse.json({
    statuses: githubActivityCache.getAll(),  // Record<slug, GithubActivity>
    pending: githubActivityCache.pending,
    total: githubActivityCache.total,
  });
}
```

(The flag gate is at the **enqueue** site in PR 2, not here — like git-status, the route is a dumb cache reader. With nothing enqueued, `getAll()` is `{}` and the strip renders nothing, so the route is harmless before PR 2 wires the enqueue.)

- [ ] **Step 2: Verify + Commit** — `feat(github): GET /api/github-activity (cache reader, mirrors /api/git-status)`

---

# Group B — Wiring + UI (PR 2)

> Outcome: the dashboard enqueues GitHub activity (gated by the flag) on each load, a hook polls it like git-status, and a compact GitHub strip appears on each card and the project detail page — with open PRs cross-linked to the sessions that created them.

### Task B1: Flag-gated enqueue in `GET /api/projects`

**Files:**
- Modify: `src/app/api/projects/route.ts` (`enrichAndEnqueue`)
- Reference: the existing `gitStatusCache.enqueue(...)` / `efficiencyGradeCache.enqueue(...)` calls in the same function.

- [ ] **Step 1:** In `enrichAndEnqueue`, build a `toEnqueueGithub: { slug, path, remoteUrl? }[]` alongside the existing git/grade lists, populated from each project's already-scanned `p.git?.remoteUrl` (so the cache skips a redundant `git` call — P3). Only enqueue when the flag is on. Because `enrichAndEnqueue` currently takes no config, read it once in the `GET` handler and pass the `featureFlags` slice down (mirror `projects/page.tsx`'s `getFlag(flags, key)` usage):

```typescript
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { githubActivityCache } from "@/lib/githubActivityCache";
// …
const config = await readConfig();
const flags = config.featureFlags;
// inside enrichAndEnqueue, after the git/grade loops:
if (getFlag(flags, "githubActivity")) {                 // default-on
  const items = projects
    .map((p) => ({ slug: p.slug, path: p.path, remoteUrl: p.git?.remoteUrl }))
    .filter((it) => githubActivityCache.get(it.slug) == null); // fresh-cache skip
  if (items.length > 0) githubActivityCache.enqueue(items);
}
```

> `ProjectData.git` must expose `remoteUrl` on the projects payload — `scanGit` already returns it (`git.ts` ~149); confirm it survives into the `/api/projects` response shape (it's on `GitInfo`). If a project's `git` is absent (non-repo), it's simply not enqueued.

- [ ] **Step 2: gating test.** Extend the projects-route test (`tests/api/projectsRoute.test.ts`) — with the flag **off** (`featureFlags:{githubActivity:false}`), assert `githubActivityCache.enqueue` is **not** called; with it **absent/true**, assert it **is** called with items carrying `remoteUrl`. (This is the route-enqueue analogue of `scannerFeatureFlags.test.ts`'s orchestrator gating — the cache is enqueued from the route, not the scanner orchestrator, exactly like `gitStatusCache`.)
- [ ] **Step 3: Verify + Commit** — `feat(github): flag-gated enqueue of GitHub activity on dashboard load`

---

### Task B2: `useGithubActivity` poll hook

**Files:**
- Create: `src/hooks/useGithubActivity.ts`
- Reference (clone): `src/hooks/useGitDirtyStatus.ts`.

- [ ] **Step 1:** Clone `useGitDirtyStatus` against `/api/github-activity`: poll every 5s, stop the interval once `pending === 0 && total > 0`, cooldown'd error toast ("GitHub activity unavailable"), return `{ statuses, pending }` where `statuses: Record<string, GithubActivity>`. Same `stopped` guard + `clearInterval` cleanup.
- [ ] **Step 2: Verify + Commit** — `feat(github): useGithubActivity poll hook (mirrors useGitDirtyStatus)`

---

### Task B3: GitHub strip on the project card

**Files:**
- Create: `src/components/GithubActivityStrip.tsx`
- Modify: `src/components/ProjectCard.tsx` (render the strip), `src/components/DashboardGrid.tsx` (thread a `githubActivity?: Record<slug, GithubActivity>` prop down to cards, like `gitDirtyOverrides`), `src/app/projects/page.tsx` (call `useGithubActivity()` and pass `statuses` into `<DashboardGrid githubActivity={…}>`).
- Reference: `DashboardGrid`'s existing `gitDirtyOverrides` prop threading; the dashboard's amber attention tokens (`var(--accent)` / `var(--status-active-text)`) used by `BoardChips`/git badges.

- [ ] **Step 1: `GithubActivityStrip`** — a compact, single-row strip (`compact` mode for the card, matching the `DevServerControl`/`BoardCompact` density). Given a `GithubActivity`:
  - `available:false` (any reason) or absent ⇒ **render nothing** (no error chrome on a card — quiet by design).
  - else show up to three muted chips: **PRs** (`⤷ {openPrCount} PR` — amber when `> 0`, hidden when `0`), **CI** (a dot/short label: green=`passing`, red/amber=`failing`, amber-pulse=`pending`, hidden when `unknown`), **pushed** (relative time from `lastPushAt` via the project's existing `date-fns` `formatDistanceToNow` helper, hidden when absent). The PR chip links to `…/pulls`; the CI chip links to `ci.url`.
- [ ] **Step 2:** Thread the data: `useGithubActivity()` in `projects/page.tsx` → `DashboardGrid` prop → `ProjectCard` → `<GithubActivityStrip activity={githubActivity?.[slug]} compact />`. Do not merge into the `git` override object (it's a separate concern); pass as its own lookup like `efficiencyGrades`.
- [ ] **Step 3: Verify + Commit** — `feat(github): GitHub activity strip on project cards`

---

### Task B4: Detail-page strip + session↔PR cross-link

**Files:**
- Modify: `src/components/ProjectDetail.tsx` (render the full-mode strip in the Overview header area)
- Reference: the per-project sessions data already exposes `prLinks` (`GET /api/sessions?project=slug`, `PrLink[]` from `prExtractor`); `src/lib/types.ts` `PrLink` (`{url, number, repo}`).

- [ ] **Step 1: Full-mode strip.** On the detail page, render `GithubActivityStrip` in non-compact mode: the open-PR count, the CI status with `workflowName`, and last-push relative time — plus an expandable list of the open PRs (`prs[]`: `#{number} {title}`, draft badge, `updatedAt` relative time, link to `pr.url`).
- [ ] **Step 2: Cross-link (best-effort, P7).** For each open PR, look up the project's session `prLinks` for a match on `repo` **and** `number`; if found, render a small "opened in session …" link to `/sessions/[sessionId]`. This is a pure presentation join over data both sides already produce — no new extraction, no cache change. No match ⇒ just the PR row. Guard for the sessions fetch being unavailable (the join is additive; the strip works without it).
- [ ] **Step 3: Verify + Commit** — `feat(github): detail-page GitHub strip + open-PR↔session cross-link`

---

# Group C — Docs + verification (PR 3)

### Task C1: Help doc + wiring

**Files:**
- Create: `docs/help/github-activity.md` and copy to `public/help/github-activity.md`
- Modify: `src/lib/help-mapping.ts` (`helpSlugs` + a route/tab mapping if a route is added; here it's a card/detail strip, so add the slug and a `tabHelpMapping`/`project-details` cross-reference rather than a new route key), `src/components/HelpPanel.tsx` (`slugTitles["github-activity"] = "GitHub Activity"`).

- [ ] **Step 1: Write `docs/help/github-activity.md`** — what the strip shows (open PRs, CI pass/fail, last push), that it's powered by the **local authenticated `gh` CLI** (and so requires `gh auth login`; absent/unauthenticated `gh` ⇒ the strip is simply hidden), the 5-min cache + background poll behavior, the rate-limit note (≈3 `gh` calls/repo, gentle batching; GraphQL is a future upgrade), and the PR↔session cross-link. Note the `githubActivity` flag in **Settings**.
- [ ] **Step 2:** Add `"github-activity"` to the `helpSlugs` array in `help-mapping.ts` and `slugTitles` in `HelpPanel.tsx`. (The strip lives on the cards + project detail, both already mapped to `getting-started`/`project-details`; add a contextual link from the detail page's help to `github-activity`.) `cp docs/help/github-activity.md public/help/github-activity.md`.
- [ ] **Step 3: Commit** — `docs(github): help doc + help-mapping/HelpPanel wiring for the GitHub activity strip`

---

### Task C2: CHANGELOG + CLAUDE.md

**Files:** `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: CHANGELOG `[Unreleased] > Added`** — a "GitHub activity surface (Portfolio Command Deck — Phase 4)" entry: the `githubActivityCache` (`gh`-backed, batched, 5-min TTL, fully defensive failure classification), `GET /api/github-activity`, the card + detail strip (open PRs, CI status, last push), the PR↔session cross-link, and the default-on `githubActivity` flag. Call out the security posture (array-args `execFile`, validated `owner/repo`) and the graceful degradation when `gh` is missing/unauthenticated.
- [ ] **Step 2: CLAUDE.md** — under **Architecture**, add a "GitHub Activity Cache (`src/lib/githubActivityCache.ts`)" bullet mirroring the "Git Status Cache" bullet (globalThis singleton, `gh` via `execFile` with array args, owner/repo from remote, defensive reason enum, enqueued by `/api/projects`, polled via `/api/github-activity`). Under **API Routes**, add `GET /api/github-activity`. Under the feature-flag references, note `githubActivity`.
- [ ] **Step 3: Commit** — `docs(github): CHANGELOG + CLAUDE.md for the GitHub activity surface`

---

### Task C3: Final verification gate

- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm test --pool=forks` — full suite green; **report exact pass count**.
- [ ] `pnpm build` — compiles (new route + card/detail strip).
- [ ] Manual: with `gh` authenticated, load the dashboard → confirm a card with an open PR shows the PR chip and a CI dot; the detail page lists the PRs and (when a session created one) the "opened in session" link. Temporarily rename `gh` on PATH (or set the flag off) → confirm the strip silently disappears and **no** error toast spams (cooldown respected), and that `/api/github-activity` still returns `{statuses:{},pending,total}`.
- [ ] Open PRs per the boundaries above (feature branch → PR; never push to `main`).

---

## Open items deferred to later phases (not Phase 4)

- **Octokit + PAT/GraphQL (roadmap Phase 5 / D3).** The `gh`-CLI approach is per-repo, multi-round-trip, and shares the user's REST rate budget; the roadmap (§9) flags ~60-repo refreshes as the likely trigger to move to a single GraphQL query per refresh (or batched) behind a PAT. `githubActivityCache`'s `fetchActivity` is the single seam to swap when that day comes — the cache shell, route, hook, and strip are transport-agnostic.
- **Live deploy/uptime/metrics (roadmap Phase 5).** Pulling live platform state (Vercel/Railway/Supabase) is a separate surface from VCS activity and stays in Phase 5; this phase is GitHub-only.
- **Bare-key ticket cross-link.** `ticketExtractor` deliberately handles full URLs only; cross-linking an open PR to a bare `ABC-123` branch-name ticket needs per-workspace config and is out of scope (the PR↔session join here uses the already-extracted `PrLink`, which is URL-derived and self-validating).
- **Caching CI run history / PR review state.** This cut shows the *latest* default-branch run and open-PR list only; per-PR check matrices and review/approval state are a richer follow-up.
- **Pinned / on-demand refresh.** Today the cache refreshes on dashboard load (TTL-gated); a manual "refresh GitHub activity" affordance (like the MCP `refresh-git-status` tool) is a small follow-up if the 5-min TTL proves too lazy.
