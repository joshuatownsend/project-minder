# Plan 005: Establish a characterization-test harness for API routes (spike + seed)

> **Executor instructions**: This is a **spike + seed** plan: prove a pattern works, then
> seed a small number of tests with it — do NOT attempt to test every route. Follow the
> steps, run every verification command, and honor STOP conditions. When done, update the
> status row in `plans/README.md` unless a reviewer told you they maintain it.
>
> **Drift check (run first)**: `git diff --stat 1b45d2b..HEAD -- src/app/api vitest.config.ts`
> If the route files below changed materially, re-read them before writing tests.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (adds tests only; no production code changes unless a route needs a tiny refactor — see STOP)
- **Depends on**: none
- **Category**: tests / direction
- **Planned at**: commit `1b45d2b`, 2026-06-13

## Why this matters

`CLAUDE.md` states plainly: "UI components and API routes are validated through `pnpm build`
+ manual browser testing." The `src/lib/` data layer is heavily tested (~2,648 tests), but
the **route boundary** — request parsing, status codes (400/403), branch selection,
cache-hit vs scan path, response shape — has no automated coverage. Typecheck catches type
drift but not behavior. Three characterization tests on the busiest/most-branchy routes
would lock that behavior and catch regressions a refactor could silently introduce. The
goal here is not coverage percentage; it's to **prove a reusable route-test pattern exists**
and seed it on three representative routes so future routes have a template.

## Current state

Routes are Next.js App Router handlers exporting async `GET`/`POST` functions. Three good
characterization targets:

- `src/app/api/projects/route.ts` — `GET`: cache-hit returns `NextResponse.json(cached)`;
  cache-miss runs `scanAllProjects()` once (single-flight guard `scanInProgress`) then caches.
  Pure read; good **pilot** (mock `@/lib/scanner` `scanAllProjects` and `@/lib/cache`).
- `src/app/api/dev-server/[slug]/route.ts` — `POST`: most branching. Validates `projectPath`
  is inside a configured devRoot (`validateProjectPath`), returns **400** when `projectPath`
  missing, **403** when outside roots, and dispatches `start`/`stop`/`restart`. Excerpt:
  ```ts
  const { action, projectPath, port } = body as { action: "start"|"stop"|"restart"; projectPath: string; port?: number };
  switch (action) {
    case "start": { if (!projectPath) return NextResponse.json({ error: "projectPath required" }, { status: 400 });
      const pathErr = await validateProjectPath(projectPath); if (pathErr) return NextResponse.json({ error: pathErr }, { status: 403 });
      const info = await processManager.start(slug, projectPath, port); return NextResponse.json(info); }
    case "stop": { /* ... */ }
  ```
- `src/app/api/usage/route.ts` — `GET` with query params (`?period=`, `?project=`,
  `?source=`); exercises query-param parsing and delegation to the usage/data layer.

`vitest.config.ts` already aliases `server-only` to a no-op stub
(`tests/fixtures/server-only-stub.ts`) and includes `tests/**/*.test.ts`. Route handlers can
therefore be imported in the vitest node environment **as long as** `next/server`
(`NextRequest`/`NextResponse`) imports resolve there.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                 | exit 0              |
| Tests     | `pnpm test -- route`             | the new route tests pass |
| Full test | `pnpm test`                      | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope** (create):
- `tests/api/projectsRoute.test.ts`
- `tests/api/devServerRoute.test.ts`
- `tests/api/usageRoute.test.ts`
- `tests/api/_helpers.ts` (a tiny shared helper for building requests / invoking handlers), if useful.
- A short "How to test a route" note — either a comment block at the top of `_helpers.ts`
  or a few lines appended to an existing testing doc.

**Out of scope** (do NOT touch unless a STOP condition forces a minimal, noted exception):
- Production route code under `src/app/api/`. The one permitted exception: if a route is
  genuinely untestable because logic is inline in the handler, you MAY extract that logic
  into a small exported function in the SAME file and have the handler call it — but only
  with an explicit note in your report, and only the minimum needed.
- The data/scanner/usage libs themselves — mock them, don't change them.

## Git workflow

- Branch: `advisor/005-api-route-tests`.
- Commit style: Conventional Commits (e.g. `test(api): characterization tests for projects/dev-server/usage routes`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Pilot — prove a route handler runs under vitest

Create `tests/api/projectsRoute.test.ts`. Mock the route's dependencies:
`vi.mock("@/lib/scanner", () => ({ scanAllProjects: vi.fn() }))`, and `@/lib/cache`
(`getCachedScan`, `setCachedScan`), `@/lib/gitStatusCache`, `@/lib/efficiencyGradeCache`.
Then `import { GET } from "@/app/api/projects/route"` and call `await GET()`.

Cases:
1. Cache hit: `getCachedScan` returns a fake `ScanResult`; assert the response JSON equals it
   and `scanAllProjects` was NOT called. (Read the body via `await res.json()`.)
2. Cache miss: `getCachedScan` returns `null` first, then the cached result after scan;
   assert `scanAllProjects` called once and the response carries its projects.

**Verify**: `pnpm test -- projectsRoute` → passes.

If `import`ing the route throws because `next/server` won't resolve under vitest, STOP and
report — the fallback is to test the route's extracted logic instead (see Scope exception),
but confirm the import problem first rather than refactoring blindly.

### Step 2: Branch/status-code coverage on the dev-server route

Create `tests/api/devServerRoute.test.ts`. Mock `@/lib/processManager` (so `start`/`stop`/
`restart` are spies) and `@/lib/config` (`readConfig`, `getDevRoots`) so `validateProjectPath`
has known roots. Build a `NextRequest`/`Request` with a JSON body and a `params` promise
(`{ params: Promise.resolve({ slug: "x" }) }`, matching the handler signature). Cases:
1. `action:"start"` with no `projectPath` → **400**.
2. `action:"start"` with a `projectPath` OUTSIDE configured roots → **403**.
3. `action:"stop"` → calls `processManager.stop` and returns its info (200).

**Verify**: `pnpm test -- devServerRoute` → passes; assert `res.status` for the 400/403 cases.

### Step 3: Query-param coverage on the usage route

Create `tests/api/usageRoute.test.ts`. Mock the usage/data layer the route calls. Build a
request with a URL carrying `?period=week&project=foo`; assert the route passes those params
through to the mocked loader and returns its result. (Read the route first to see exactly
which lib function it calls and the param names.)

**Verify**: `pnpm test -- usageRoute` → passes.

### Step 4: Document the pattern

In `tests/api/_helpers.ts` (or a top-of-file comment in one test), document the 3-line
recipe: how to mock libs, how to construct a request + `params` promise, how to read
`res.status` / `await res.json()`. Keep it short — it's a template for the next contributor.

### Step 5: Full verification

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass; `pnpm lint` → exit 0.

## Test plan

- Three route test files (projects/dev-server/usage) covering: cache hit/miss, 400/403/200
  status codes, and query-param pass-through respectively.
- All mocking at the lib boundary; no real fs/process/db.
- The pilot (Step 1) is the gate: if route handlers can't be imported under vitest, the
  whole approach changes — surface that before writing the other two.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; the three `tests/api/*Route.test.ts` files exist and pass
- [ ] `pnpm lint` exits 0
- [ ] At least one test asserts a non-200 status code (400 or 403 on the dev-server route)
- [ ] The route-test pattern is documented (comment or note)
- [ ] No production code under `src/app/api/` changed, OR the only change is a noted minimal
      logic-extraction needed for testability (`git diff src/app/api`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Importing a route handler under vitest fails (e.g. `next/server` resolution) — report the
  exact error before attempting any route refactor.
- A route's behavior can't be observed without real I/O even after mocking the lib layer —
  report which route and why.
- Constructing `NextRequest` in the node test env behaves differently from production in a
  way that would make the test assert the wrong thing.

## Maintenance notes

- This is a seed, not full coverage. Future routes should follow the documented pattern; new
  status-code branches deserve a characterization test in the same PR.
- If route handlers prove awkward to import, the durable fix is the "thin handler, fat lib"
  pattern (handler parses request → calls an exported, unit-testable lib function). Note that
  recommendation for the maintainer if you hit friction.
- Reviewer should check the tests assert *behavior* (status codes, delegation, response shape),
  not implementation details that will churn.
