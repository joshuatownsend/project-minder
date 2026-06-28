# Portfolio Command Deck — Phase 3 Implementation Plan (per-project Operations panel)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parent plan:** This is the task-by-task implementation of **Phase 3** of `docs/superpowers/plans/2026-06-25-portfolio-command-deck.md` (the roadmap, §7 "Phase 3 — Per-project Operations panel", ~line 246). The roadmap locks the *decisions*; this doc locks the *tasks, files, and code*. When in conflict, the roadmap's data model wins over any convenience shape; **the live codebase wins over the roadmap on mechanics** — the scanners this phase composes (`cicd.ts`, `envFile.ts`) are already merged and tested, so they are the substrate, not new ground.

**Goal:** Give every project one **operational view** — "where does this deploy, what does it depend on, what runs on a schedule, and what do I do when it breaks?" — assembled mostly from detection Minder already performs. Two deliverables: (1) an **`OpsSummary` derive layer** (`src/lib/ops/summary.ts`) that *composes* already-scanned fields (`CiCdInfo.hosting`, `vercelCrons`, `dependabot`, `externalServices`, `DatabaseInfo`) into a single operational shape — **no new scanning**; and (2) an **`OPERATIONS.md` runbook** — a new canonical, living-checklist planning file for the ~30% of operational truth that can't be auto-detected (backups, monitoring/alerting, on-call/escalation, secrets/rotation, restore procedure), with a tolerant parser (`src/lib/scanner/operationsMd.ts`). Both feed an `OpsPanel` tab on the project detail page, gated behind a default-on `scanOps` flag.

**Architecture:** This phase is **a derive-and-present layer over already-merged scanners plus one small new parser.** The orchestrator (`src/lib/scanner/index.ts:134-194`) already runs `scanCiCd` (unconditional, `index.ts:185`) and `scanEnvFiles` (unconditional, `index.ts:159`) and attaches their results to `ProjectData` (`cicd` at `index.ts:248`; `database`/`externalServices` at `index.ts:230-231`). `scanCiCd` returns `{ workflows, hosting, vercelCrons, dependabot }` (`cicd.ts:47-53`) — `hosting` is the merged Vercel/Railway/Fly/Render/Netlify/Heroku/Docker target list (`cicd.ts:33-37`), `vercelCrons` comes from `parseVercelCrons` (`cicd.ts:273`), `dependabot` from `parseDependabot` (`cicd.ts:196`). `scanEnvFiles` returns `{ database, externalServices }` from `SERVICE_PATTERNS` key-name matching (`envFile.ts:10-31, 100-112`) and `parseDatabaseUrl` (`envFile.ts:33-60`). **The derive layer reads those fields off `ProjectData` and reshapes them — it never touches the filesystem**, so the `OpsPanel` can compute the summary client-side from props (mirroring `BoardTab`, which takes `board={project.board}` at `ProjectDetail.tsx:586`, rather than fetching like `GsdPlanningTab` at `ProjectDetail.tsx:596`).

The only **new I/O** is `scanOperationsMd` — modeled exactly on the existing markdown scanners: a pure `parseOperationsMd(content)` plus a thin `scanOperationsMd(projectPath)` wrapper that reads `OPERATIONS.md` with a literal filename in the join (so static analysis sees a fixed path component — same comment as `boardMd.ts:194-197` / `manualStepsMd.ts:92`). It follows the **living-checklist convention**: completed/obsolete runbook items move to `OPERATIONS.archive.md` (also committed), the scan orchestrator never reads `*.archive.md`, and an on-demand `scanOperationsArchive` mirrors `scanBoardArchive` (`boardMd.ts:209-221`) / `scanManualStepsArchive` (`manualStepsMd.ts:108-123`). It honors the **canonical-main-tree** rule: `OPERATIONS.md` is project-scoped, not branch-scoped, so any future writer must route through `canonicalProjectDir` (`canonicalProjectPath.ts:73-76`) — v1 ships read-only (human-curated runbook), so no writer exists yet, but the help doc and CLAUDE.md authoring block state the rule for hand edits inside worktrees.

The flag `scanOps` gates **only the new `scanOperationsMd` scan** (the derive layer composes fields that are already populated unconditionally), default-on, neutral when off — same shape as `scanBoard` (`index.ts:178-180`, `featureFlags.ts:190-197`). When `scanOps` is off, `project.operations` is `undefined` and the panel still renders the auto-detected half; the curated half shows an "add an `OPERATIONS.md` runbook" prompt.

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, Vitest. Package manager: **pnpm**. Verification gate per `CLAUDE.md`: `pnpm typecheck` + full `pnpm test --pool=forks` (report exact pass count), and `pnpm build` for the UI tab wiring. New scanner/flag behavior gets `tests/*.test.ts` per the testing convention; gating gets a `tests/scannerFeatureFlags.test.ts` case and the flag registration gets `tests/featureFlags.test.ts` coverage.

---

## Decisions baked into this plan

| # | Decision | Rationale |
|---|----------|-----------|
| P1 | **`OpsSummary` is a pure derive function (`deriveOpsSummary`), not a scanner** | It only reshapes fields already on `ProjectData` (`cicd`, `externalServices`, `database`, `operations`). No FS, no async — so it's unit-testable like a parser and runnable client-side in the panel. Roadmap 3a: "No new scanning — a derive-and-present layer (`src/lib/ops/summary.ts`)." |
| P2 | **The `OpsPanel` consumes `project` props and derives client-side — no new API route** | The inputs are already serialized into the `/api/projects` payload. Mirrors `BoardTab` (props-driven, `ProjectDetail.tsx:586`) rather than `GsdPlanningTab` (fetch-driven). Adding the panel is a *tab*, not a *route*, so no `helpMapping` route entry is needed — only a `tabHelpMapping` entry. |
| P3 | **`OPERATIONS.md` is a living-checklist canonical planning file** — same §5 rules as TODO/MANUAL_STEPS/BOARD | Completed/obsolete items move to `OPERATIONS.archive.md` (committed); the scan orchestrator ignores `*.archive.md`; an on-demand `scanOperationsArchive` reads it. Canonical-main-tree: worktree edits target the parent checkout. Directly parallels `scanBoardArchive` (`boardMd.ts:209`) and `scanManualStepsArchive` (`manualStepsMd.ts:108`). |
| P4 | **v1 runbook is read-only (human-curated)** — no toggle/edit writer | Unlike `MANUAL_STEPS.md` (Minder toggles checkboxes) the runbook's value is curated prose + facts; there's no "mark done" UX in v1. The parser still records checkbox state (`- [ ]`/`- [x]`) so a future writer can be added — and **if** one is, it must canonicalize via `canonicalProjectDir` (`canonicalProjectPath.ts:73`), exactly as the board/manual-steps writers do. |
| P5 | **Five known runbook sections, recognized by heading, tolerant of synonyms; unknown `##` sections pass through** | Roadmap fixes the five facts: **backups**, **monitoring/alerting**, **on-call/escalation**, **secrets/rotation**, **restore**. The parser maps each `## heading` to a `OpsSectionKey` via a synonym table and keeps unrecognized sections as `key: "other"` so hand-written runbooks aren't silently dropped — same "deliberately tolerant of hand edits" stance as `boardMd.ts:27-29`. |
| P6 | **`scanOps` gates only `scanOperationsMd`** (the new scan), default-on, neutral-when-off | The derive layer composes fields populated by `scanCiCd`/`scanEnvFiles`, which are **not** flag-gated today (`index.ts:159, 185`; confirmed by the "non-gated scanners always run" test, `scannerFeatureFlags.test.ts:308-330`). So `scanOps=false` only nulls `project.operations`; auto-detected ops still render. Matches the roadmap §8 "every new scanner gated" rule without over-gating existing detection. |
| P7 | **Service-detection extensions are key-name + host-substring only — the "where cheap" bar** | Roadmap 3c: extend `SERVICE_PATTERNS` (`envFile.ts:10`) with PlanetScale and tag a managed-DB `provider` on `DatabaseInfo` by host substring inside `parseDatabaseUrl` (`envFile.ts:33`) — Neon (`*.neon.tech`), PlanetScale (`*.psdb.cloud`), Supabase (`*.supabase.co`), Upstash, Railway, Render. No new files read, no network — purely richer parsing of strings already in hand. `Firebase`/`Upstash` already exist (`envFile.ts:26, 30`) — don't duplicate. |
| P8 | **`OpsSummary.coverage` reports an auto-vs-curated ratio, not a hardcoded "70%"** | The roadmap's "~70% auto-detected" is an *aspiration*, not a constant. `coverage` counts populated auto-detected groups vs. the five curated runbook sections present, so the panel can show an honest "4 of 9 operational facts captured" nudge toward filling the runbook. |

**Suggested PR boundaries** (each independently green under the verification gate):
- **PR 1 — Derive layer + service detection** (Group A): `OpsSummary` types + `deriveOpsSummary` + `envFile.ts` provider/PlanetScale extensions + tests. No new scanner, no flag, no UI — pure logic the panel will later consume. Self-contained and shippable.
- **PR 2 — `OPERATIONS.md` runbook scanner** (Group B): `operationsMd.ts` parser + `OperationsInfo` types + `scanOps` flag registration + orchestrator wiring + `ProjectData.operations` + scanner/flag tests. The data layer for the curated half.
- **PR 3 — UI + docs** (Group C): `OpsPanel` tab on the detail page, `docs/help/operations.md` (+ `public/help/` mirror) + help wiring, `CHANGELOG.md`, `CLAUDE.md` (+ the OPERATIONS.md authoring block), final verification.

---

# Group A — `OpsSummary` derive layer + service detection (PR 1)

> Outcome: `deriveOpsSummary(project)` returns a single operational shape composed from already-scanned fields; `envFile.ts` recognizes a few more managed services/DB providers cheaply. Pure logic only — no scanner, no flag, no UI.

### Task A1: `OpsSummary` types + `deriveOpsSummary`

**Files:**
- Create: `src/lib/ops/summary.ts`
- Create: `tests/opsSummary.test.ts`
- Modify: `src/lib/types.ts` (add the `OpsSummary` family of interfaces near `CiCdInfo`, `types.ts:1177`)
- Reference (do not duplicate): `src/lib/types.ts` — `CiCdInfo`/`HostingTarget`/`VercelCron`/`DependabotUpdate` (`types.ts:1158-1182`), `DatabaseInfo` (`types.ts:283-288`); `src/lib/scanner/cicd.ts` (field provenance); `OperationsInfo` is added in B1 — import it as an optional input here.

- [ ] **Step 1: Types** (in `types.ts`). Keep them serializable (the panel reads them off the API payload):

```typescript
export interface OpsCron {
  schedule: string;            // raw cron expr
  path?: string;               // vercel cron route, if any
  source: "vercel" | "workflow";
  sourcePath: string;
}

export interface OpsSummary {
  deployTargets: HostingTarget[];   // from CiCdInfo.hosting
  services: string[];               // from ProjectData.externalServices
  database?: DatabaseInfo;          // from ProjectData.database
  crons: OpsCron[];                 // vercelCrons + workflow schedule crons
  dependabot: DependabotUpdate[];   // from CiCdInfo.dependabot
  runbook?: OperationsInfo;         // from OPERATIONS.md (B1); undefined when scanOps off / absent
  /** Honest auto-vs-curated coverage for the "fill your runbook" nudge (P8). */
  coverage: { autoGroups: number; curatedSections: number; curatedTotal: 5 };
}
```

- [ ] **Step 2: `deriveOpsSummary`** — pure, takes only the slices it needs so callers/tests don't build a whole `ProjectData`:

```typescript
import type { ProjectData, OpsSummary, OpsCron, HostingTarget } from "../types";

type OpsInput = Pick<ProjectData, "cicd" | "externalServices" | "database" | "operations">;

export function deriveOpsSummary(p: OpsInput): OpsSummary {
  const deployTargets: HostingTarget[] = p.cicd?.hosting ?? [];
  const services = p.externalServices ?? [];
  const dependabot = p.cicd?.dependabot ?? [];

  const crons: OpsCron[] = [
    ...(p.cicd?.vercelCrons ?? []).map((c) => ({
      schedule: c.schedule, path: c.path, source: "vercel" as const, sourcePath: c.sourcePath,
    })),
    ...(p.cicd?.workflows ?? []).flatMap((w) =>
      w.cron.map((schedule) => ({ schedule, source: "workflow" as const, sourcePath: w.file })),
    ),
  ];

  const autoGroups =
    (deployTargets.length > 0 ? 1 : 0) +
    (services.length > 0 ? 1 : 0) +
    (p.database ? 1 : 0) +
    (crons.length > 0 ? 1 : 0);
  const curatedSections = p.operations?.sections.filter((s) => s.key !== "other").length ?? 0;

  return {
    deployTargets, services, database: p.database, crons, dependabot,
    runbook: p.operations,
    coverage: { autoGroups, curatedSections, curatedTotal: 5 },
  };
}

/** True when there's anything operational worth a tab (drives panel visibility). */
export function hasOps(s: OpsSummary): boolean {
  return s.deployTargets.length > 0 || s.services.length > 0 || !!s.database ||
    s.crons.length > 0 || s.dependabot.length > 0 || !!s.runbook;
}
```

> `Workflow.cron` is already populated by `normalizeTriggers` (`cicd.ts:106-131`) — merging it surfaces GitHub Actions `schedule:` crons alongside Vercel crons in one list. Confirm the `Workflow` import shape in `types.ts`.

- [ ] **Step 3: tests** (`tests/opsSummary.test.ts`) — pure, no mocks. Cover: deploy targets pass through from `cicd.hosting`; services/db/dependabot pass through; crons merge from both `vercelCrons` and `workflows[].cron` with correct `source`; empty/absent `cicd` yields empty arrays (no throws); `coverage.autoGroups` counts populated groups; `coverage.curatedSections` counts only non-`other` runbook sections; `hasOps` is `false` for a fully-empty project and `true` when any group is present.
- [ ] **Step 4: Verify + Commit** — `feat(ops): OpsSummary derive layer composing cicd/env detection`

---

### Task A2: cheap `envFile.ts` service-detection extensions

**Files:**
- Modify: `src/lib/scanner/envFile.ts`
- Modify: `src/lib/types.ts` (add optional `provider?: string` to `DatabaseInfo`, `types.ts:283`)
- Create: `tests/envFile.test.ts` (no env-file test exists today)

- [ ] **Step 1: PlanetScale key pattern.** Add to `SERVICE_PATTERNS` (`envFile.ts:10-31`) — keep alphabetical-ish grouping, don't re-add `Firebase`/`Upstash` (already at `envFile.ts:26, 30`):

```typescript
PlanetScale: ["PLANETSCALE_DB", "PSCALE_TOKEN", "DATABASE_URL"], // host-confirmed below
```

> `DATABASE_URL` alone is ambiguous, so PlanetScale should only be *added to services* when the host substring confirms it (Step 2) — gate the key-name match on the provider detection rather than listing `DATABASE_URL` here. Simpler: detect PlanetScale/Neon purely from the DB host in Step 2 and push the provider name into `externalServices`; reserve `SERVICE_PATTERNS` for genuine dedicated keys (`PLANETSCALE_DB`, `PSCALE_TOKEN`).

- [ ] **Step 2: tag a managed-DB `provider` by host substring** inside `parseDatabaseUrl` (`envFile.ts:33-60`), and surface it as a service. Host→provider table (substring match on `parsed.hostname`):

```typescript
const DB_HOST_PROVIDERS: Array<[substr: string, name: string]> = [
  [".neon.tech", "Neon"],
  [".psdb.cloud", "PlanetScale"],
  [".supabase.co", "Supabase"],
  [".upstash.io", "Upstash"],
  ["railway", "Railway"],
  [".render.com", "Render"],
];
```

Set `result.database.provider` and add the provider name to `detectedServices` (the set built at `envFile.ts:101`) so it shows in `externalServices` and, transitively, in `OpsSummary.services`. Keep it null-safe: `provider` stays `undefined` for self-hosted/unknown hosts.

- [ ] **Step 3: tests** (`tests/envFile.test.ts`) — mock `fs` at module level (`vi.mock("fs")`, the project convention, e.g. `tests/manualStepsMd.test.ts`). Cover: a Neon `DATABASE_URL` sets `database.provider === "Neon"` and adds `"Neon"` to `externalServices`; a PlanetScale host → `"PlanetScale"`; a plain `postgres://localhost` leaves `provider` undefined and adds no managed-provider service; existing key-name detection (`STRIPE_SECRET_KEY` → `"Stripe"`) still works (regression guard); `PLANETSCALE_DB` key alone → `"PlanetScale"`.
- [ ] **Step 4: Verify + Commit** — `feat(scanner): detect managed DB providers + PlanetScale in envFile`

---

# Group B — `OPERATIONS.md` runbook scanner (PR 2)

> Outcome: `scanOperationsMd(dir)` parses the curated runbook into structured sections; a default-on `scanOps` flag gates it; `project.operations` is attached in the orchestrator. Living-checklist + canonical-main-tree conventions honored.

### Task B1: `operationsMd.ts` parser + `OperationsInfo` types

**Files:**
- Create: `src/lib/scanner/operationsMd.ts`
- Create: `tests/operationsMd.test.ts`
- Modify: `src/lib/types.ts` (add `OperationsInfo` family near `BoardInfo`, `types.ts:526`)
- Reference (do not duplicate): `src/lib/scanner/manualStepsMd.ts` (checkbox/detail-line parsing + `scanManualStepsArchive`, `manualStepsMd.ts:9-123`), `src/lib/scanner/boardMd.ts` (literal-filename read + `scanBoardArchive`, `boardMd.ts:188-221`).

- [ ] **Step 1: Types** (in `types.ts`):

```typescript
export type OpsSectionKey =
  | "backups" | "monitoring" | "oncall" | "secrets" | "restore" | "other";

export interface OpsRunbookItem {
  text: string;
  done: boolean;        // `- [x]` vs `- [ ]` (P4: recorded, not toggled in v1)
  details: string[];    // indented continuation lines
  lineNumber: number;   // 1-based, for a future writer
}

export interface OpsRunbookSection {
  key: OpsSectionKey;
  heading: string;      // verbatim `## ` heading text
  body: string;         // prose under the heading (non-checkbox lines)
  items: OpsRunbookItem[];
  line: number;         // 1-based heading line
}

export interface OperationsInfo {
  sections: OpsRunbookSection[];
  totalItems: number;
  pendingItems: number;
}
```

- [ ] **Step 2: `parseOperationsMd(content): OperationsInfo | undefined`** — pure, no FS. Split on `## ` headings; map each heading to a key via a synonym table (case-insensitive, substring):

```typescript
const SECTION_SYNONYMS: Array<[re: RegExp, key: OpsSectionKey]> = [
  [/backup|snapshot|retention/i, "backups"],
  [/monitor|alert|observability|uptime|metric/i, "monitoring"],
  [/on.?call|escalation|pager|incident contact/i, "oncall"],
  [/secret|rotation|credential|key management|env var/i, "secrets"],
  [/restore|recovery|disaster|runbook|rollback/i, "restore"],
];
```

Within a section, recognize `- [ ]`/`- [x]` items (reuse the `COMPLETED_RE`/`PENDING_RE` shape from `manualStepsMd.ts:6-7`) with indented detail lines, and accumulate non-checkbox prose into `body`. Unknown headings → `key: "other"` (P5). Return `undefined` when there are no sections (so the orchestrator can leave `operations` undefined, like `parseManualStepsMd` gating on `totalSteps > 0`, `manualStepsMd.ts:97`).

- [ ] **Step 3: `scanOperationsMd(projectPath)` + `scanOperationsArchive(projectPath)`** — thin wrappers, literal filename in the `path.join` (static-analysis note, copy from `boardMd.ts:194-197`):

```typescript
export async function scanOperationsMd(projectPath: string): Promise<OperationsInfo | undefined> {
  try {
    const content = await fs.readFile(path.join(projectPath, "OPERATIONS.md"), "utf-8");
    return parseOperationsMd(content);
  } catch { return undefined; }
}
// scanOperationsArchive → reads "OPERATIONS.archive.md"; on-demand only — the
// orchestrator never reads archive files (matches scanBoardArchive, boardMd.ts:209).
```

- [ ] **Step 4: tests** (`tests/operationsMd.test.ts`) — `vi.mock("fs")` per convention. Cover: each of the five headings (and a synonym, e.g. `## Disaster Recovery` → `restore`, `## Alerting` → `monitoring`) maps to the right `key`; checkbox items counted into `totalItems`/`pendingItems` with `done` state; indented detail lines attach to their item; prose lines land in `body`; an unknown `## Cost notes` heading → `key: "other"`; empty/whitespace file → `undefined`; `scanOperationsMd` returns `undefined` on ENOENT; `scanOperationsArchive` reads the `.archive.md` filename.
- [ ] **Step 5: Verify + Commit** — `feat(scanner): OPERATIONS.md runbook parser (living-checklist sections)`

---

### Task B2: `scanOps` flag + orchestrator wiring + `ProjectData.operations`

**Files:**
- Modify: `src/lib/types.ts` (add `"scanOps"` to `FeatureFlagKey`, `types.ts:562-581`; add `operations?: OperationsInfo` to `ProjectData`, after `board` at `types.ts:75`)
- Modify: `src/lib/featureFlags.ts` (add `"scanOps"` to `FEATURE_FLAG_KEYS`, `featureFlags.ts:6-26`; add a `FEATURE_FLAG_META` entry, `featureFlags.ts:42-198`)
- Modify: `src/lib/scanner/index.ts` (import + gate `scanOperationsMd`, attach `operations`)
- Modify: `tests/featureFlags.test.ts`, `tests/scannerFeatureFlags.test.ts`

- [ ] **Step 1: `FeatureFlagKey` + flag registration.** Add `"scanOps"` to the union (`types.ts:581`, after `scanBoard`) and to `FEATURE_FLAG_KEYS` (`featureFlags.ts:25`, after `scanBoard`). Add the meta entry mirroring `scanBoard` (`featureFlags.ts:190-197`):

```typescript
{
  key: "scanOps",
  label: "Scan OPERATIONS.md",
  description: "Reads OPERATIONS.md (backups, monitoring, on-call, secrets, restore) for the per-project Operations panel.",
  group: "passive",
  appliesAt: "scan",
  wired: true,
},
```

- [ ] **Step 2: `ProjectData.operations`** — add after the board field (`types.ts:75`):

```typescript
  // Operations runbook (OPERATIONS.md — curated facts, living-checklist)
  operations?: OperationsInfo;
```

- [ ] **Step 3: orchestrator wiring** (`src/lib/scanner/index.ts`). Import `scanOperationsMd` (`index.ts:16` neighborhood). Add a gated call to the `Promise.all` (`index.ts:157-194`), exactly like `scanBoard` (`index.ts:178-180`):

```typescript
    getFlag(flags, "scanOps")
      ? scanOperationsMd(projectPath)
      : Promise.resolve(undefined),
```

destructure it into a new `operations` binding (alongside `board`, `index.ts:145`) and attach it to the `project` object (after `board`, `index.ts:245`): `operations,`.

- [ ] **Step 4: flag tests** (`tests/featureFlags.test.ts`) — the existing `FEATURE_FLAG_META` "covers every key exactly once" (`featureFlags.test.ts:53-57`) and the `FeatureFlagKey` union compile check (`featureFlags.test.ts:39-44`) cover registration automatically once the key is added; bump the `>= 12` count assertion only if it now lags reality (it won't — it's a floor). No new case strictly required, but add an explicit `getFlag(undefined, "scanOps") === true` default-on assertion for documentation.
- [ ] **Step 5: scanner gating test** (`tests/scannerFeatureFlags.test.ts`) — add `vi.mock("@/lib/scanner/operationsMd", () => ({ scanOperationsMd: vi.fn() }))` (`scannerFeatureFlags.test.ts:62` neighborhood), import + `vi.mocked` it (`:105`), set a benign return in `setupHappyPath` (`:181`, e.g. `{ sections: [], totalItems: 0, pendingItems: 0 }`), assert it's called once on the default-on path (`:194-216`), add a `scanOps=false skips scanOperationsMd and leaves operations undefined` case (mirror the `scanBoard=false` case, `:238-245`), and add `scanOperationsMd` to the "non-gated scanners" off-everything case so the new flag joins the all-off sweep (`:308-330`).
- [ ] **Step 6: Verify + Commit** — `feat(scanner): scanOps flag wires OPERATIONS.md into ProjectData`

---

# Group C — UI `OpsPanel` + docs + final verification (PR 3)

### Task C1: `OpsPanel` tab on the project detail page

**Files:**
- Create: `src/components/OpsPanel.tsx`
- Modify: `src/components/ProjectDetail.tsx` (TabKey union `:55`, `hasOps`/tabs array `:161-187`, tab content switch `:585-596`, import)
- Modify: `src/lib/help-mapping.ts` (`tabHelpMapping`, `:52-71`)

- [ ] **Step 1: `OpsPanel` component.** Props-driven (P2), mirroring `BoardTab`'s prop signature (`ProjectDetail.tsx:586`). Compute the summary once: `const ops = deriveOpsSummary(project)`. Render dense, operational sections (per `PRODUCT.md`: data panels, muted amber for attention, condensed labels):
  - **Deploy targets** — `ops.deployTargets` (platform + `detail`, e.g. framework/region from `HostingTarget.detail`).
  - **Services** — `ops.services` chips (reuse the chip styling from `BoardChips.tsx` if it fits).
  - **Database** — `ops.database` (type/host/`provider`).
  - **Schedules** — `ops.crons` (schedule + path + source).
  - **Dependabot** — `ops.dependabot` ecosystems.
  - **Runbook** — `ops.runbook` sections (backups/monitoring/oncall/secrets/restore); for each of the five expected `OpsSectionKey`s with **no** section present, show a muted "not documented — add to `OPERATIONS.md`" row, and surface `coverage` ("N of 9 operational facts captured").

  Accept the panel taking `project: ProjectData` (so it has `cicd`/`externalServices`/`database`/`operations`) — or destructure the four slices — to keep it serializable and testable.

- [ ] **Step 2: wire the tab.** Add `"ops"` to the `TabKey` union (`ProjectDetail.tsx:55`). Add `const hasOps_ = hasOps(deriveOpsSummary(project));` near `hasBoard` (`:161`) — import `deriveOpsSummary`/`hasOps` from `@/lib/ops/summary`. Add a conditional tab entry after `board` (`:175`): `...(hasOps_ ? [{ key: "ops" as TabKey, label: "Ops" }] : [])`. Add the content branch after the board branch (`:585-587`): `{activeTab === "ops" && <OpsPanel project={project} />}`. Add `tabHelpMapping.ops = "operations"` (`help-mapping.ts:52-71`).
- [ ] **Step 3: Verify + Commit** — `feat(ui): per-project Operations panel (OpsPanel tab)`

> UI/components aren't unit-tested in this repo (validated via `pnpm build` + manual browser per `CLAUDE.md`). `deriveOpsSummary`'s correctness is already covered by A1's unit tests — the panel is a thin renderer over it.

### Task C2: help docs

**Files:**
- Create: `docs/help/operations.md` + `public/help/operations.md` (mirror)
- Modify: `src/lib/help-mapping.ts` (`helpSlugs`, `:74-120`)
- Modify: `src/components/HelpPanel.tsx` (`slugTitles`, `:9-55`)

- [ ] **Step 1: write `docs/help/operations.md`** — what the panel shows (auto-detected: deploy targets, services, DB+provider, schedules, Dependabot), how to write the curated `OPERATIONS.md` runbook (the five sections with examples), the **living-checklist** rule (move done/obsolete facts to `OPERATIONS.archive.md`, committed; never delete), and the **canonical-main-tree** rule (inside a worktree, edit the parent checkout's `OPERATIONS.md`). `cp` it to `public/help/operations.md`.
- [ ] **Step 2: register the slug.** Add `"operations"` to `helpSlugs` (`help-mapping.ts:74-120`) and `operations: "Operations"` to `slugTitles` (`HelpPanel.tsx:9-55`). (`HelpSlug` is derived from `helpSlugs`, so `slugTitles` becomes type-required — typecheck enforces it.)
- [ ] **Step 3: Commit** — `docs(operations): help doc for the Operations panel + OPERATIONS.md runbook`

### Task C3: CHANGELOG + CLAUDE.md

**Files:** `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: CHANGELOG `[Unreleased] > Added`** — a "Per-project Operations panel" entry (OpsSummary derive layer; OPERATIONS.md runbook scanner with living-checklist archive; managed-DB provider detection; `scanOps` flag; OpsPanel tab + help).
- [ ] **Step 2: CLAUDE.md** — under Architecture add `src/lib/ops/summary.ts` (derive layer) and `src/lib/scanner/operationsMd.ts` (10th scanner module — bump the "9 scanner modules" count at the Scanner section); under UI note the `OpsPanel` tab; add `scanOps` to the conventions/flags note; and add a brief **"Operations Runbook (OPERATIONS.md)"** authoring block alongside the Manual Steps Logging block, stating the five sections, the living-checklist archive rule, and the canonical-main-tree rule for worktrees.
- [ ] **Step 3: Commit** — `docs: CHANGELOG + CLAUDE.md for the Operations panel`

### Task C4: Final verification gate

- [ ] `pnpm typecheck` — clean (the `HelpSlug`/`FeatureFlagKey` unions force the registration edits to be complete).
- [ ] `pnpm test --pool=forks` — full suite green; **report exact pass count**.
- [ ] `pnpm build` — compiles (the new tab + panel).
- [ ] Manual: open a project with a `vercel.json` + crons + `DATABASE_URL` → confirm deploy target, services, DB provider, and schedules render in the Ops tab; add an `OPERATIONS.md` with the five sections → confirm the runbook half renders and `coverage` updates; toggle `scanOps` off in Settings → confirm the runbook half drops to "not documented" while auto-detected ops persist.
- [ ] Open PRs per the boundaries above (feature branch → PR; never push to `main`).

---

## Open items deferred to later phases (not Phase 3)

- **GitHub activity surface** (roadmap Phase 4) — `githubActivityCache` (gh CLI) + `/api/github-activity` + card/detail strip. Flag `githubActivity`.
- **Live ops status** (roadmap Phase 5) — pull live deploy state / uptime / metrics from platform APIs or the connected Vercel/Railway/Supabase MCPs. Upgrades this static panel to live.
- **Runbook write path** — v1 is read-only (P4). A "mark item resolved" / "add fact" writer (and an MCP `ops_*` tool) is a later refinement; if added it must canonicalize via `canonicalProjectDir` and follow the board/manual-steps writer pattern (file-lock → atomic write → re-parse).
- **Cross-project Ops board** — an `/operations` route aggregating every project's `OpsSummary` (gaps, missing backups, stale Dependabot) is out of scope; v1 is per-project only.
- **Propagating the OPERATIONS.md convention via `setup-content.ts`** — teaching *other* projects' CLAUDE.md to author runbooks (as the living-checklist convention does for TODO/MANUAL_STEPS) is deferred, matching how `scanBoard` shipped without a `setup-content.ts` entry.
