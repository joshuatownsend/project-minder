# Demo-mode coverage audit

*Wave 12, 2026-08-16. Supersedes the four-instance list in
`docs/superpowers/plans/2026-08-08-backlog-burndown.md` item 2.*

Demo mode (`MINDER_DEMO=1`, or the `demoMode` feature flag) exists so first-run
installs, screenshots and live demos are safe to show other people. A route that
serves the user's real data there fails in precisely the situation it was built
for.

The plan called for "an audit rather than four patches", on the reasoning that
*four known instances found by one audit is weak evidence that there are exactly
four*. That reasoning held: the audit found substantially more, **and** found
that one of the four named instances was not a leak at all.

## Method, and what it cannot tell you

Coverage is transitive — most routes are guarded not in the handler but at a
seam upstream (`scanAllProjects`, the `data/index.ts` façade, the catalog
loaders). So the audit walks the local import graph from each of the 165
`route.ts` files rather than reading them one at a time.

**Both error directions are real, and neither is small.** Treat the counts below
as a search aid, never as a verdict:

- **False positives.** Reaching a real-data *source* is not reading it.
  `notifications/push/vapid-public-key` shows as touching `~/.claude` because
  something it imports does; it returns a public key. `/api/adapters` shows as
  touching four sources and in fact returns the code-defined adapter registry.
- **False negatives — the dangerous direction.** Reaching a `demoMode()` *call*
  is not being guarded by it. `/api/claude-config` was classified **covered**
  because a module it transitively imports contains a guard for something else
  entirely. Its user-scope half was completely unguarded, and it is the route
  behind `/hooks` and `/config`.

The consequence: **the count of guarded routes is unreliable in the optimistic
direction.** Every finding below was confirmed by reading the code path. Nothing
here was concluded from what a page rendered — the plan's 4:1 correction came
from exactly that mistake, where fixtures were reported as leaks because they
looked like real data.

Raw pass output: `scripts/`-free, reproduced by the two scratch scripts recorded
in the PR; rerun by walking `src/app/api/**/route.ts` imports.

## Counts

| Bucket | n | Meaning |
|---|---|---|
| Total API routes | 165 | |
| Reaches a `demoMode()` call transitively | 77 | **Not** the same as guarded — see above |
| Write-guarded only (`demoWriteBlock`) | 7 | Mutation blocked; reads may still leak |
| No guard reachable at all | 81 | The search space |
| Of those, reach a real-data source | 83¹ | Upper bound, heavy false-positive rate |

¹ Exceeds 81 because the write-guarded-only routes are counted here too.

## Verified findings

### Fixed in this wave

| Surface | What leaked | Guarded at |
|---|---|---|
| `/api/stats` cross-check | Real session + message totals from `~/.claude/stats-cache.json` | `getStatsCache()` / `getStatsCacheMtimeMs()` |
| `/api/workflows`, `/api/workflows/[id]` (#441) | Workflow names, run counts, session ids, absolute script paths | `walkClaudeWorkflows()` |
| `/api/plans` | Plan titles — they describe what the user is building | `scanClaudePlans()` |
| `/api/plans/[slug]` | Full plan bodies | the route (it bypasses the scanner) |
| `/api/adapters/[id]/config` | Real harness config home, plus full text of rules files | the route |
| `/api/claude-config` → `/hooks`, `/config` | User-scope hook commands, MCP servers, plugin list, absolute `sourcePath`s | `getUserConfig()` |
| `RootLayout` (every route) | The configured `devRoot` | the shell |

### Confirmed *not* a leak

- **`/api/adapters`** — returns the code-defined adapter registry plus `enabled`
  flags. The plan listed it beside `/plans` and `/config`; the list route is
  clean and only its `[id]/config` sibling leaks. Left alone deliberately.

### Known-outstanding

The 81-route search space has not been fully triaged. The families most likely
to contain real leaks, by inspection of what they import and return:

- `telemetry/*` (8 routes) — read the index DB directly.
- `sessions/[sessionId]/*` analysis routes (10) — session-derived.
- `tasks/*`, `swarms/*`, `schedules/*`, `inbox`, `decisions`, `kanban` — the
  tasks DB, which demo mode does not model at all.
- `agent-view/*`, `claude-status/*`, `pulse`, `drift`, `status`, `library`,
  `instructions`, `insights-report`, `context-overhead`.
- `usage/export` — exports the real usage report to CSV/JSON.

These are tracked in `TODO.md` rather than fixed here, because several need a
fixture that demo mode does not yet have (there is no synthetic tasks DB), which
is the same work as the wave's "~18 empty screens" item.

## Rule for new routes

Guard at the **seam the data flows through**, once — the loader or façade the
route calls — not in the handler. A handler guard closes one route; a loader
guard stays closed when the next route reuses the loader. Both workflow routes
and both plans routes shared a loader, and only one of the four pairs needed a
second guard (the plans detail route, which opens the file itself).

And make the guard unconditional. A guard that stops applying when a caller
passes an argument — `walkClaudeWorkflows({ projectsDir })` was the temptation
here — is the "guard that silently stops guarding" shape this repo has now
fixed several times.
