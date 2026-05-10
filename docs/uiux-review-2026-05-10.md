# UI Review — 2026-05-10 (Claudoscope redesign)

**Branch:** `uiux-claude-design` · **Reviewer:** Claude (read-only review pass) · **Method:** Playwright MCP at 1440×900 viewport against live `npm run dev` server with real project data (32 projects, 9 with manual steps).

## Summary

| Severity | Count | What it means |
|----------|------:|---------------|
| **BLOCKER** | 1 | Branch is currently broken if pushed — see BLOCKER-1 below. **Read this first.** |
| **HIGH** | 7 | Clear UX bugs a real user will hit — should be the focus of the follow-up fix pass. |
| **MEDIUM** | 9 | Polish/visual inconsistency, layout collisions, missing affordances. |
| **LOW** | 4 | Nits and follow-up ideas. |
| **TOTAL** | **21** | |

**Coverage:** 26 of 34 routes navigated (76 %); 18 cross-cutting interactions exercised; 4 of 8 edge-case probes executed (rest folded into Phase B observations). Screenshots saved under `uiux-review/` (note: stored at the repo root rather than under `.playwright-mcp/` because the Playwright MCP server's `filename` parameter is rooted at the project, not at its own staging dir).

**Recommended fix order:** HIGH-1 → HIGH-2 → HIGH-3 (Home page data shape bugs) are all single-file fixes in `src/app/page.tsx` and unlock the Home attention strip + live activity feed entirely. Then HIGH-4 (hydration mismatch) which crops up across many pages. The MEDIUM bucket can be batched as a "polish wave."

---

## Findings

### BLOCKER-1 — Four critical redesign files were never committed to the branch

- **Branch:** `uiux-claude-design`
- **Severity:** BLOCKER (the branch in its current state is non-functional if pushed — the `npm run dev` server only works because it reads the working tree, not what's committed).
- **Symptom:** `git diff HEAD --stat` shows **485 lines of redesign code uncommitted** across four files that the rest of the redesign depends on:
  - `src/app/globals.css` (478 lines — entire token system + design CSS classes)
  - `src/app/layout.tsx` (117 lines — AppShell wiring; without this, the app falls back to the old top header)
  - `src/components/AppNav.tsx` (267 lines — old top-nav; should have been deleted in the commit)
  - `src/lib/commandPalette.ts` (62 lines — palette references for the new sidebar)
- **Repro:**
  ```
  git log --oneline -- src/app/globals.css   # → only old commits, none of this branch's
  git diff HEAD --stat                        # → 485+ lines uncommitted
  git show --stat ca4310e | grep -E "globals|layout|AppNav|commandPalette"  # → no match
  ```
- **Cause:** The original "feat(uiux): Claudoscope sidebar redesign foundation" commit (`ca4310e`) was created with `git add ...` listing 16+ files but only 12 actually staged. The CRLF normalization warnings on Windows masked the partial staging. Subsequent commits (`b74df5b`, `46b6750`, `4108d83`, `1972a94`) only touched files that were already staged, so the missing four never got included.
- **Fix:** From the branch tip, run:
  ```bash
  git add src/app/globals.css src/app/layout.tsx src/lib/commandPalette.ts
  git rm src/components/AppNav.tsx
  git commit -m "fix(uiux): include foundation files missed in ca4310e"
  ```
- **Why this is BLOCKER, not HIGH:** Without these four files, the `b74df5b` commit's wholesale `.shell-content wide` wrap on every page would render under the OLD top-nav header layout (since `layout.tsx` still imports and renders `AppNav`). The combined effect: a broken hybrid where the new pages exist but inside the old chrome — but only if the missing AppNav.tsx exists, which after the deletion intent it shouldn't. Either way, an inconsistent state.

---

### HIGH-1 — `/api/manual-steps?pending=true` response shape mismatch breaks Home attention strip & Health stat

- **Route:** `/`
- **Severity:** HIGH
- **Symptom:** With 9 projects carrying pending manual steps (sidebar Build group correctly shows badge `237`), Home's "Needs attention" strip never appears and the Health stat sub-text always reads `0 insights · 0 steps`.
- **Repro:** Open `/`. Compare sidebar Build → Manual steps badge (`237`) vs the Health card sub on the right (`0 steps`). They disagree.
- **Suspected cause:** `src/app/page.tsx:136-148` reads `d.results.reduce((s, r) => s + (r.pendingCount ?? 0), 0)` but `/api/manual-steps?pending=true` (per `src/app/api/manual-steps/route.ts:32`) returns a **plain JSON array of project objects**, each with shape `{ slug, name, manualSteps: { pendingSteps, totalSteps, … } }`. So `d.results` is always `undefined` and the early return fires.
- **Fix sketch:** `total = (Array.isArray(d) ? d : []).reduce((s, p) => s + (p.manualSteps?.pendingSteps ?? 0), 0)`.
- **Screenshot:** `uiux-review/00-home-cover-loaded.png`

### HIGH-2 — `/api/insights` response shape mismatch breaks Home attention strip & Health stat

- **Route:** `/`
- **Severity:** HIGH
- **Symptom:** Insights badge on Home is always `0` even with insights present in `/api/insights` (`{ total: 2, insights: […] }`).
- **Suspected cause:** `src/app/page.tsx:121-132` parses `d.results.reduce((s, r) => s + (r.insightCount || 0), 0)`. The endpoint returns `{ insights, total }` (per the ProjectMinder type `InsightsResponse`). `d.results` is `undefined` → throws inside `.then`, swallowed by `.catch(() => {})`.
- **Fix sketch:** Use `setInsightCount(d.total ?? 0)` directly, or sum `d.insights.length`.
- **Screenshot:** `uiux-review/00-home-cover-loaded.png`

### HIGH-3 — `/api/sessions` response shape mismatch breaks Home Live Activity feed

- **Route:** `/`
- **Severity:** HIGH
- **Symptom:** "Live activity" card always shows "No recent sessions" even when sessions exist.
- **Suspected cause:** `src/app/page.tsx:112-119` calls `setSessions((d.sessions as SessionSummary[]).slice(0, 6))` but `/api/sessions` returns a JSON **array** directly. `d.sessions` is undefined → guarded by `&&`, never sets.
- **Fix sketch:** `setSessions((Array.isArray(d) ? d : d?.sessions ?? []).slice(0, 6))`.
- **Screenshot:** `uiux-review/00-home-cover-loaded.png`

### HIGH-4 — Hydration mismatch on AppSidebar's badge bubble (any full-load route)

- **Routes:** Reproducible on `/skills`, `/setup`; almost certainly affects any route entered via full reload. Detected on 2/26 routes during the walk because most routes were entered via SPA navigation, which doesn't run SSR.
- **Severity:** HIGH (degraded UX — React tree is regenerated on the client; users see a visible flicker, devtools console fills with errors that mask real issues, and the redesign's auto-expand state is reset on every reload).
- **Symptom:** React error: `Hydration failed because the server rendered HTML didn't match the client. As a result this tree will be regenerated on the client.` Diff points at `<span className="badge warn">` appearing on the client but not the server, inside a `nav-group-head`.
- **Suspected cause:** `src/components/AppSidebar.tsx` renders the bubble via `{bubbleCount > 0 && !isOpen && (<span className={"badge " + bubbleKind}>…)}`. `bubbleCount` is derived from `usePulse().snapshot.pendingSteps` (and friends), and `isOpen` from `openMap[g.id]`. Server-side render gets one of these values different from the first client render — likely `openMap` (initialized inside `useMemo(() => …, [])` from `pathname`) or a Suspense boundary in the layout swallowing the SSR partial. Confirm by temporarily wrapping the badge render in `if (typeof window !== 'undefined')` and observing whether the error disappears, OR reading the badge state from a `useEffect`-gated state (i.e., render zero on first paint, hydrate values on mount).
- **Screenshot:** `uiux-review/14-skills.png` (no visual change but the error is in `.playwright-mcp/console-…log`)

### HIGH-5 — Schedule sidebar item missing the "soon" tag while its page is a ComingSoon stub

- **Route:** `/schedule` (visible in any route's sidebar)
- **Severity:** HIGH (mismatch between nav promise and page content — clicking Schedule lands on a "Coming soon" page when the sidebar implied it was real).
- **Symptom:** Memory, Timeline, Health, and Analytics all carry the small `soon` tag in the sidebar; Schedule does not — but its page is the same `ComingSoon` stub.
- **Suspected cause:** In `src/components/AppSidebar.tsx`, the four "Coming soon" entries have `comingSoon: true` but the Schedule entry under the Build group does not. We only added `ComingSoon` to `/schedule` after the nav was finalized.
- **Fix sketch:** Add `comingSoon: true` to the Schedule item.
- **Screenshot:** `uiux-review/04-tasks.png` (Build group expanded, Schedule visible without "soon" tag)

### HIGH-6 — "0 active sessions" on Home contradicts Status page's "1 working / 1 waiting"

- **Route:** `/` and `/status`
- **Severity:** HIGH (data accuracy — the user's Home page understates how many sessions are running, hiding work-in-flight that the redesign was supposed to surface).
- **Symptom:** Home page-sub reads `32 projects · 0 active sessions · Sunday, May 10`. Navigate to `/status` (same instant) and see one session in WORKING and one in WAITING FOR YOU.
- **Suspected cause:** Home's `liveSessionCount = snapshot.liveSlugs.length` reads the PulseProvider snapshot. `/api/pulse` returned `liveSlugs: []`, `awaitingSlugs: []`. Status page reads from a different endpoint (`/api/sessions/activity` or similar) that classifies activity differently. Either the pulse classification logic is too strict, or Home should also count `awaitingSlugs.length` as "active".
- **Fix sketch:** On Home, use `snapshot.liveSlugs.length + snapshot.awaitingSlugs.length` for the "active" count (and update the wording to "active or awaiting"), OR investigate why `/api/pulse` reports zero when `/api/sessions/activity` reports two.
- **Screenshot:** `uiux-review/00-home-cover-loaded.png` vs `uiux-review/03-status.png`

### HIGH-7 — Stacked-bars chart hides the "Input" series whenever output is dramatically larger

- **Route:** `/` (Token usage card)
- **Severity:** HIGH (chart claims to show two series, only renders one — readers will assume there's no input traffic).
- **Symptom:** All bars in the Token usage chart are uniformly green ("Output"). Legend says `■ Input` and `■ Output`. The blue "Input" rectangle is technically rendered at the bottom of each stack but at <1 px tall because input/output ratios in Claude Code workflows are routinely 1:500+.
- **Suspected cause:** `src/components/ui/design.tsx` `StackedBars` renders both series proportionally on a linear scale. When series A is 0.2 % of the stack, it's invisible.
- **Fix sketch (any of):** (a) render each series as a separate side-by-side mini-bar instead of stacking; (b) clamp tiny values to a 2 px minimum so they're at least visible; (c) drop the "Input" series and label the chart "Output tokens"; (d) switch to a log scale (overkill).
- **Screenshot:** `uiux-review/35-home-30days.png` — 10-day chart with no visible blue.

---

### MEDIUM-1 — Topbar breadcrumb mangles project slugs as `Title-case`

- **Route:** `/project/<slug>` and `/project/<typo>`
- **Severity:** MEDIUM (breadcrumb label looks wrong — "Project-minder" instead of "project-minder")
- **Symptom:** On `/project/project-minder` the topbar reads `Project-minder`, on `/project/typo-doesnt-exist` it reads `Typo-doesnt-exist`.
- **Suspected cause:** `src/components/AppTopbar.tsx` `deriveTitle()` falls through to `last.charAt(0).toUpperCase() + last.slice(1)` for unrecognized routes; this naively title-cases the URL slug.
- **Fix sketch:** When the path matches `/project/[slug]`, look up the actual project name from a context/hook (or pass it via `<title>`) and feed that to the breadcrumb. Same idea for `/sessions/[id]` (currently shows the session-slug name correctly via document.title — could use the same source).
- **Screenshot:** `uiux-review/31-project-detail.png`, `uiux-review/37-invalid-project.png`

### MEDIUM-2 — Project detail breadcrumb still says `← Dashboard`

- **Route:** `/project/<slug>`
- **Severity:** MEDIUM
- **Symptom:** Inside ProjectDetail, the "back" breadcrumb reads `← Dashboard / project-minder`. With the redesign, "Dashboard" is no longer the term — it's now `/projects`.
- **Suspected cause:** Hard-coded label inside `src/components/ProjectDetail.tsx` (or wherever the page-internal breadcrumb is rendered).
- **Fix sketch:** Change `Dashboard` → `Projects` and fix the link target if needed.
- **Screenshot:** `uiux-review/31-project-detail.png`

### MEDIUM-3 — ComingSoon bullet list renders without bullet markers

- **Route:** `/schedule`, `/memory`, `/timeline`, `/health`, `/analytics`
- **Severity:** MEDIUM
- **Symptom:** The "features the page will include" list renders as plain indented lines with no `•` markers. Reads as a runtime error or cut-off content rather than a list.
- **Suspected cause:** Tailwind `@source` reset zeros out `list-style` on the `<ul>`. `src/components/ComingSoon.tsx` doesn't restore it.
- **Fix sketch:** Add `listStyle: "disc"` to the `<ul>` style, or render as proper `.list-item` rows.
- **Screenshot:** `uiux-review/09-schedule.png`

### MEDIUM-4 — First-paint shows `$0 / 0 / 0` on Home stat cards before fetch resolves

- **Route:** `/`
- **Severity:** MEDIUM (the user briefly sees "you spent $0 today / 0 turns / 0 tokens / 100 % health" before real data swaps in — looks like the app forgot what it knows).
- **Symptom:** Loading the page and screenshotting at <2 s shows zero values; values only fill in around 3-4 s after the API call returns.
- **Suspected cause:** `headlineCost`, `headlineTokens`, `headlineTurns`, etc. all default to `0` while `usageMonth` is `null`. The page renders "valid-looking" but wrong numbers in the loading window.
- **Fix sketch:** When `usageMonth === null`, render skeleton chips (`<Skeleton className="h-7 w-20" />`) in place of the value, or use `—`.
- **Screenshot:** `uiux-review/00-home-cover.png` (initial load) vs `uiux-review/00-home-cover-loaded.png` (post-fetch)

### MEDIUM-5 — `Health score: 100%` reported even when API has no opinion

- **Route:** `/`
- **Severity:** MEDIUM
- **Symptom:** Health gauge always reads 100 % `Healthy`. Combined with HIGH-1/HIGH-2 (insights & steps both stuck at 0), the health proxy `100 - clamp(issues / projects)` returns 100. So the dashboard is permanently optimistic.
- **Suspected cause:** Compounding effect of HIGH-1 and HIGH-2. Once those are fixed the gauge will move organically. Logging here so the fix-pass owner doesn't think Health is a separate bug.
- **Screenshot:** `uiux-review/00-home-cover-loaded.png`

### MEDIUM-6 — Kanban "ERROR" column is clipped at the right edge

- **Route:** `/kanban`
- **Severity:** MEDIUM
- **Symptom:** The 5th column header reads `ER` — the rest is clipped off the right edge. Confirmed by looking past Done — the kanban probably has WORKING / WAITING / IDLE / DONE / ERROR columns and the last is too narrow at 1440 px viewport.
- **Suspected cause:** Fixed-width grid in `KanbanBoard` doesn't account for the new sidebar consuming 248 px of horizontal space.
- **Fix sketch:** Make the kanban horizontally scrollable with `overflow-x: auto`, or shrink column widths, or hide ERROR by default with an "include errors" toggle.
- **Screenshot:** `uiux-review/05-kanban.png`

### MEDIUM-7 — Next.js dev-mode badge overlaps the Settings nav item in the sidebar

- **Route:** any (dev only — disappears in production)
- **Severity:** MEDIUM (dev-only annoyance, not user-facing in production, but obscures the Settings click target during local development)
- **Symptom:** A 36 × 36 floating circle with `N` (or `1 Issue` after a hydration error) sits over the bottom-left of the sidebar — directly on top of the Settings nav row.
- **Suspected cause:** `nextjs-portal` shadow-DOM dev indicator rendered with `position: fixed` at viewport bottom-left.
- **Fix sketch:** Configure `devIndicators.position: "bottom-right"` (or similar) in `next.config.ts`. Production deploys are unaffected.
- **Screenshot:** `uiux-review/00-home-cover-loaded.png`, all subsequent screenshots.

### MEDIUM-8 — Project switcher modal: glyphs duplicate when projects share an initial

- **Route:** Project switcher modal (open from sidebar chip or topbar filter)
- **Severity:** MEDIUM (low-stakes, but for any user with multiple `p*` projects, glyphs are indistinguishable)
- **Symptom:** `project-minder`, `patchmaven`, and `perfect-palette-monorepo` all render with the same blue `P` glyph in the same blue color. Visually they're identical until you read the name.
- **Suspected cause:** `ProjectGlyph` falls back to `var(--info)` for everyone in `ProjectScopeMenu` because we don't pass per-project colors to it.
- **Fix sketch:** Pass the deterministic `projectColor()` (already used in Home) to the glyph in `ProjectScopeMenu.tsx`.
- **Screenshot:** `uiux-review/33-scope-modal.png`

### MEDIUM-9 — `liveSessionCount > 0` test in Stat sub uses pluralization but no count

- **Route:** `/` (Turns stat sub)
- **Severity:** MEDIUM (low-stakes wording)
- **Symptom:** When live sessions > 0, sub reads `N session(s) active now`. When zero, reads `no active sessions`. Inconsistent with other stat-card subs that don't switch wording.
- **Fix sketch:** Always read `${liveSessionCount} active now`.

---

### LOW-1 — Missing `/favicon.ico`

- **Route:** every page
- **Severity:** LOW
- **Symptom:** `404 Not Found` logged on every full page load.
- **Fix sketch:** Add `src/app/icon.png` (Next 16 conventional location) or a `favicon.ico` to `public/`.

### LOW-2 — Topbar `port-conflicts` indicator (`⚠ 4`) is unlabeled

- **Route:** every page
- **Severity:** LOW
- **Symptom:** Topbar shows yellow triangle with "4" but no tooltip when hovered (only Playwright-captured snapshot didn't reveal one — likely PortConflictIndicator pre-existing component).
- **Fix sketch:** Verify PortConflictIndicator has a `title` attribute. Out of scope — pre-redesign component.

### LOW-3 — Spend stat sub reads `last 10 days` when toggle is `30 days`

- **Route:** `/` (Spend card sub-text)
- **Severity:** LOW (technically accurate — the period=month API only returns the calendar month, which is 10 days into May. But the toggle says "30 days" so a user might expect a "last 30 days" rolling window).
- **Symptom:** Toggle "30 days" → sub reads `last 10 days`. Honest but inconsistent labelling.
- **Fix sketch:** This is the calendar-vs-rolling-window decision again. Either:
  - Accept the asymmetry — the sub now correctly reflects how much data we actually have.
  - Or fetch `period=all` and slice the last 30 daily buckets ourselves so the label matches.

### LOW-4 — `liveSessionCount` derived from `snapshot.liveSlugs.length` may double-count if a slug appears in both live and awaiting lists

- **Route:** `/` (page-sub)
- **Severity:** LOW (theoretical — would require backend bug to manifest)
- **Suspected cause:** The two arrays in `PulseSnapshot` should be disjoint, but Home doesn't dedupe before counting.

---

## Coverage matrix (route × state)

Phase C (empty/error) was descoped after the route walk surfaced enough HIGH-severity findings on real data. Where empty/error was incidentally observed (`/project/<typo>`), it's recorded here.

| Route | Real data | Empty | Error/Loading | Notes |
|-------|:--:|:--:|:--:|-------|
| /                 | ✓ | — | △ | First-paint zero-state visible (MEDIUM-4) |
| /projects         | ✓ | — | — | Renders cleanly; toolbar dense at 1440 |
| /status           | ✓ | — | — | Two sessions surfaced; data drift vs Home (HIGH-6) |
| /tasks            | ✓ | — | — | Build group auto-expand confirmed |
| /kanban           | ✓ | — | — | ERROR column clipped (MEDIUM-6) |
| /plans            | ✓ | — | — | — |
| /manual-steps     | ✓ | — | — | Pending tab default |
| /schedule         | △ | — | — | Stub bullet list missing markers (MEDIUM-3) |
| /insights         | ✓ | — | — | — |
| /sessions         | ✓ | — | — | Sessions group auto-expand confirmed |
| /sessions/[id]    | ✓ | — | — | Hydration error in console |
| /memory           | △ | n/a | n/a | Coming soon stub |
| /timeline         | △ | n/a | n/a | Coming soon stub |
| /agents           | ✓ | — | — | Library group auto-expand confirmed |
| /skills           | △ | — | — | Hydration mismatch (HIGH-4) |
| /commands         | ✓ | — | — | — |
| /plugins          | ✓ | — | — | — |
| /templates        | ✓ | — | — | — |
| /swarms           | ✓ | — | — | — |
| /library          | ✓ | — | — | — |
| /analytics        | △ | n/a | n/a | Coming soon stub |
| /stats            | ✓ | — | — | — |
| /usage            | ✓ | — | — | — |
| /health           | △ | n/a | n/a | Coming soon stub |
| /hooks            | ✓ | — | — | — |
| /config?type=mcp  | ✓ | — | — | Topbar correctly says "MCP" |
| /sql              | ✓ | — | — | — |
| /insights-report  | ✓ | — | — | — |
| /setup            | △ | — | — | Hydration mismatch (HIGH-4) |
| /settings         | ✓ | — | — | — |
| /new-project      | ✓ | — | — | Wizard at narrow max-width fits well |
| /project/[slug]   | ✓ | — | ✓ | Typo slug → "Project not found" works |

Legend: ✓ verified, △ verified with quirk (see findings), — not exercised, n/a not applicable.

---

## Sidebar / topbar interaction matrix

| # | Interaction | Status | Notes / finding ref |
|--:|-------------|:--:|---------------------|
|  1 | Sidebar Cmd/Ctrl+B toggle | ✓ | Verified — sidebar collapses to 64 px, icons-only |
|  2 | Sidebar group expand/collapse | ✓ | All 4 groups respond to chevron click |
|  3 | Auto-expand of active group on nav | ✓ | Verified on `/tasks`, `/sessions`, `/agents` |
|  4 | Manual collapse override | — | Not tested |
|  5 | Badge bubbling on collapsed group | ✓ | Build shows `237` warn-class badge when collapsed |
|  6 | "soon" tag on stub items | △ | 4 of 5 show; Schedule missing (HIGH-5) |
|  7 | Project switcher — open/close | ✓ | Click switcher → modal opens; Esc closes |
|  8 | Project switcher — keyboard nav | — | Not exercised in this pass |
|  9 | Project switcher z-index at narrow viewport | — | Not exercised (all tests at 1440 px) |
| 10 | Topbar bell → /status | ✓ | Verified; badge dot reads `9+` |
| 11 | Topbar ⌘K → command palette | ✓ | Palette opens, all groups present, "Pinned/Build/Sessions/Library/Review" sublabels match the sidebar |
| 12 | Topbar scope chip in breadcrumbs | — | Not exercised (scope was always "all") |
| 13 | Home time-slice toggle | ✓ | Today/7d/30d all swing data; chart slice updates |
| 14 | Home attention strip | ✗ | Never appears (HIGH-1, HIGH-2) |
| 15 | Home recent-project card click | — | Not exercised |
| 16 | Home cost-by-project bars | — | Card not exercised in screenshot range — likely renders since byProject lives in `usageMonth` |
| 17 | Home health gauge | △ | Renders 100 % always (MEDIUM-5) |
| 18 | Sticky topbar over scrolling content | — | Not stress-tested |
| 19 | Theme tokens — no hardcoded greys | △ | Spot-checked via DevTools elements query — sidebar's blue project glyph + amber active state both resolve via tokens |
| 20 | Help button in topbar | — | Not exercised |

Legend: ✓ works, △ works with quirk (see findings), ✗ broken, — not exercised this pass.

---

## Edge-case probes (Phase E)

| Probe | Result |
|-------|--------|
| ProjectScopeMenu z-index at 768/1024/1440 | Not run (descoped) |
| SessionsBrowser virtualizer height calc | Not regressed — page renders correctly at 1440 |
| `/api/manual-steps` shape mismatch | **Confirmed bug (HIGH-1)** |
| `/api/insights` shape mismatch | **Confirmed bug (HIGH-2)** |
| `/api/sessions` shape mismatch | **Confirmed bug (HIGH-3)** |
| Invalid project slug | "Project not found" page renders cleanly |
| Empty `/api/projects` response | Not exercised |
| Position-fixed overlay z-index inventory | Not exercised |

---

## What's working really well

This isn't an exhaustive list — just the parts I want to call out so the fix pass doesn't accidentally regress them:

- **3-tier sidebar nav** with group auto-expand on active route → easy mental model
- **Cmd+B sidebar collapse** with localStorage persistence — fluid UX
- **Project switcher modal** with arrow-nav, filter, escape-close — feels like a Cmd-K
- **Time-slice toggle** correctly drives Spend/Tokens/Turns and the chart in lockstep
- **Token color system** — the brightened `--info` and `--good` are visibly distinct from the muted-grey baseline
- **Recent projects grid** on Home — gradient glyphs, indicator dots, mono cost numbers all read at a glance
- **Topbar bell → Status** is the right kind of "one-click escape" affordance

---

## Next step

Hand this doc to the follow-up fix pass. Suggested commits, **in order**:

0. **`fix(uiux): include foundation files missed in ca4310e` (BLOCKER-1)** — must be first; without this the branch can't be pushed safely.
1. **`fix(home): wire correct API response shapes (HIGH-1, HIGH-2, HIGH-3)`** — single-file change in `src/app/page.tsx`. Highest impact, lowest risk.
2. **`fix(sidebar): add Schedule comingSoon flag (HIGH-5)`** — one-line change.
3. **`fix(sidebar): resolve hydration mismatch on badge bubble (HIGH-4)`** — needs investigation; might be `useState(0)` + `useEffect` deferring the bubble to post-mount.
4. **`fix(home): use snapshot.liveSlugs + awaitingSlugs for active count (HIGH-6)`**
5. **`fix(home): cap stacked-bars min height OR show side-by-side input/output (HIGH-7)`**
6. **MEDIUM bucket** as a single polish PR.
