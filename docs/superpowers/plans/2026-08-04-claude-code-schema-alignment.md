# Claude Code schema alignment (v2.1.202 → 2.1.222)

*Created 2026-08-04. Status table below is the source of truth.*

## Driver

Claude Code shipped ~20 releases (2.1.202 → 2.1.222) that widened the transcript
schema, added new model tiers, and introduced surfaces Minder has no reader for.
Minder's premise is that the filesystem is the source of truth — so its ceiling
is set by how much of the JSONL schema it actually decodes. Several fields Minder
currently **infers** are now written **explicitly** by the CLI, and Anthropic has
already shipped a fix for the exact over-attribution bug that Minder's inference
still has (2.1.222: *"Fixed `/usage` overattributing usage to MCP servers"*).

This is mostly a *decode more of what's already on disk* plan, not a *build new
machinery* plan. Most of the value is retroactive across existing history.

## Evidence

Measured on 2026-08-04 by scanning the 30 most-recently-modified `.jsonl` files
under `~/.claude/projects/` and counting key frequency by entry type. Every field
below has **zero** references in `src/` today.

| Field | Carried on | Count | Sample value |
|---|---|---:|---|
| `effort` | `type:"assistant"` | 6979 | `"medium"`, `"high"` |
| `entrypoint` | attachment / assistant / user / system | 20810 | `"cli"` |
| `sessionKind` | attachment / assistant / user / system | 2959 | `"bg"` |
| `attributionMcpServer` + `attributionMcpTool` | `type:"assistant"` | 1782 | `"plugin:context-mode:context-mode"` / `"ctx_fetch_and_index"` |
| `aiTitle` | **`type:"ai-title"`** (new entry type) | 1367 | `"Explore app distribution with Tauri and MCP"` |
| `permissionMode` | **`type:"permission-mode"`** (new entry type) | 1358 | `"auto"` |
| `attributionSkill` | `type:"assistant"` | 920 | `"code-review"` |
| `prNumber` + `prUrl` + `prRepository` | **`type:"pr-link"`** (new entry type) | 788 | `4` / `…/pull/4` / `joshuatownsend/bluecat-docs-scraper` |
| `hookInfos` | `type:"system"` | 166 | `[{command:"codegraph sync", durationMs:1450}, …]` |
| `promptSource` | `type:"user"` | 159 | `"typed"` |
| `toolDenialKind` | `type:"user"` | 20 | `"automode-blocked"` |

Three of these are **new entry types** (`pr-link`, `ai-title`, `permission-mode`).
Both of Minder's JSONL readers switch on `entry.type`, so those lines are silently
dropped today — not mis-parsed, just invisible.

## The key semantic distinction (read before touching attribution)

`tool_uses.skill_name` / `tool_uses.mcp_server` already exist and are **inferred**
from the `mcp__server__tool` naming convention (`src/lib/usage/mcpParser.ts:12`).
They answer *"was this call a skill/MCP invocation?"*

The new `attributionSkill` / `attributionMcpServer` fields sit on **assistant**
turns and answer a different question: *"which skill or MCP server is responsible
for the existence of this turn's tokens?"* That is causal cost attribution.

**Therefore:** the new fields go on `turns`, not `tool_uses`. Keep the existing
`tool_uses` inference for call **counts**; switch cost **attribution** to the new
fields. Conflating them reproduces the bug this fixes — attributing every turn
after a tool result to that server, instead of only the turns that consumed it.

## Constraints

1. **Dual read path.** Every field must be threaded through *both* backends or the
   DB path silently returns `undefined`: JSONL parse → `UsageTurn`/`SessionSummary`
   → `schema.sql` column → `migrations.ts` → `src/lib/data/*FromDb.ts` → route → UI.
   `MINDER_USE_DB=0` must produce identical output.
2. **Two independent readers.** `src/lib/usage/parser.ts:133` (`parseSessionTurns`
   → `UsageTurn`) and `src/lib/scanner/claudeConversations.ts:125` (`scanSessionFile`
   → `SessionSummary`). Neither delegates to the other. Cost-shaped fields go
   through the first; session-shaped fields through the second; `effort` needs both.
3. **`DERIVED_VERSION` is the re-parse trigger.** Currently `12`
   (`src/lib/db/derivationVersion.ts:22`). Bumping it forces a **full re-parse of
   all history** — expensive on this machine (`index.db` ~834 MB). Bump **once**,
   in Wave A.1, and let every later A-slice ride that single re-parse. Do not bump
   per slice.
4. **Schema version.** Highest existing migration is `19`
   (`src/lib/db/migrations.ts:39`). New work starts at **20**.
5. **All new fields are optional and version-dependent.** `effort` did not exist
   before 2.1.212; `pr-link` entries did not exist before ~2.1.218. Every UI must
   have an explicit `unknown` bucket rather than defaulting to a value — a session
   with no `effort` is not a `medium` session.
6. **Demo mode.** `src/lib/demo/` fixtures must gain the new fields or demo
   surfaces render empty panels.
7. **Gates** (per `CLAUDE.md`): `pnpm typecheck`, full `pnpm test`, and `pnpm build`
   for anything touching `src/`. Never pipe a gate through a filter.

## Status

| # | Slice | Wave | Depends on | Status |
|---|---|---|---|---|
| B1 | Pricing correctness: fallback refresh + cache-TTL split | B | — | **Done** (branch `b1-pricing-fallback-refresh`) |
| A1 | Transcript schema decode + migration 20 + `DERIVED_VERSION` 13 | A | — | Not started |
| A2 | Effort analytics (cost & one-shot rate by reasoning effort) | A | A1 | Not started |
| A3 | `sessionKind` segmentation (interactive / bg / attached) | A | A1 | Not started |
| A4 | Authoritative skill + MCP cost attribution | A | A1 | Not started |
| A5 | Authoritative PR linkage (`type:"pr-link"`) | A | A1 | Not started |
| A6 | Hook performance + permission/denial analytics | A | A1 | Not started |
| C1 | `.claude/workflows/` catalog | C | — | Not started |
| C2 | Runaway-delegation guardrail badges | C | A1 | Not started |
| C3 | OTEL `tool_source` / `message.uuid` correlation | C | — | Not started |
| C4 | `DirectoryAdded` hook + skill frontmatter parity | C | — | Not started |

Suggested order: **B1 → A1 → (A2 ‖ A3 ‖ A4 ‖ A5 ‖ A6) → (C1 ‖ C2 ‖ C3 ‖ C4)**.
B1 first because it is a live correctness bug and touches nothing else. A1 is the
critical path for the whole A wave. C-slices are independent of each other.

---

# Wave B — pricing correctness (ship first)

## B1 — Pricing correctness — SHIPPED

> **Scope grew during implementation, with approval.** Probing the transcripts to
> answer the fast-mode question (below) turned up a larger bug in the same
> module: **95.5% of all cache-creation tokens are 1-hour-TTL writes, billed at
> 2× base rather than the 1.25× Minder applied to all of them.** Unlike the
> fallback table — which only bites when LiteLLM is unreachable — that one
> mispriced every session, always. Re-pricing the full local corpus (3,726
> transcripts, 126,962 turns) moves reported spend from $27,756 to $31,895, a
> **$4,139 / 14.9% understatement**. It was absorbed into B1 rather than
> deferred, since shipping a "pricing correctness" PR that knowingly left it in
> place would have been wrong.
>
> **`DERIVED_VERSION` was deliberately NOT bumped** (still 12), per constraint 3:
> stored per-turn `cost_usd` values stay stale until A1's single full re-parse
> corrects them. A1 must land for the historical numbers to move.
>
> **Fast mode is detectable after all** — `message.usage.speed` is present on
> every assistant turn (7,070/7,070 in the probe sample, all `"standard"`), and
> `usage.service_tier` sits beside it. The pricing table now carries the rates,
> but *threading* `speed` from JSONL through to `getModelPricing` is schema work
> that belongs with A1's field expansion, not here. Tracked as an A-wave item.
>
> Also fixed, both found while editing: `applyPricingOverlay` dropped the
> optional >200k tiered rates (so a single user pricing rule silently disabled
> long-context pricing), and three separate hand-rolled copies of the cost
> formula — in `daily_costs` rollup and twice in the conversation scanner — had
> drifted from `applyPricing`; they now delegate to it.

**Problem.** `src/lib/usage/costCalculator.ts` has zero references to Opus 5. Its
offline tables stop at the Claude 4 generation:

- `FALLBACK_PRICING` (`:10`) — `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-3.5`
- keyword match (`:189-196`) — `opus` → `claude-opus-4` rates
- `FALLBACK_MAX_CONTEXT` (`:229`) — all `200_000`, catch-all `return 200_000` (`:246`)

Live LiteLLM pricing masks this while the network is up. When it isn't, an Opus 5
session is priced at Opus 4 rates and its context gauge reads **200k against a 1M
window** — a 5× error in the direction that makes context pressure look safe when
it isn't. That feeds `max_context_fill`, `contextAttribution.ts`, `burnHud`, and
the efficiency grades.

**Work.**
- Add Claude 5-generation entries to `FALLBACK_PRICING` and `FALLBACK_MAX_CONTEXT`
  (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`), with 1M context where the
  model has it. Keep the existing `[1m]`/`:1m` suffix handling at `:241`.
- Reorder keyword matching so a generation-qualified id resolves before the bare
  `opus`/`sonnet`/`haiku` fallback, and so an unknown *future* Claude id inherits
  the newest known rates rather than the oldest.
- **Fast mode** (2.1.219: Opus 5 fast mode at $10/$50 per Mtok) is a *different
  rate for the same model id*. Investigate whether the JSONL distinguishes it —
  probe `message.usage` and `message.diagnostics` for a fast-mode marker. If it
  does not, do **not** guess: document the limitation in `docs/help/` and leave
  fast-mode turns priced at standard rates with a note, rather than silently
  mispricing in either direction.

**Tests.** `tests/costCalculator.test.ts` — offline-fallback pricing for each
Claude 5 id; context window returns 1M not 200k; unknown `claude-opus-9` inherits
newest-known rather than Opus 4; non-Claude ids still resolve to $0 (the existing
`""`-sentinel behaviour at `:198-211` must not regress).

**Risk.** Low. Isolated module with existing test coverage. No schema change.

---

# Wave A — transcript schema expansion

## A1 — Decode layer + migration (critical path)

The plumbing slice. **No user-visible change** beyond fields becoming available;
ships alone so the re-parse cost is paid once and in isolation.

**Parsers.**
- `src/lib/scanner/claudeConversations.ts:36` — widen `ConversationEntry` with
  `effort`, `sessionKind`, `entrypoint`, `promptSource`, `permissionMode`,
  `toolDenialKind`, `attributionSkill`, `attributionMcpServer`,
  `attributionMcpTool`, `hookInfos`, `prNumber`/`prUrl`/`prRepository`, `aiTitle`.
- Add handling for the three **new entry types** in both readers' type switches:
  `pr-link`, `ai-title`, `permission-mode`. Today they fall through unhandled.
- `src/lib/usage/types.ts:10` — add `effort?`, `attributionSkill?`,
  `attributionMcpServer?`, `attributionMcpTool?`, `sessionKind?` to `UsageTurn`.
- `src/lib/types/session.ts:29` — add `sessionKind?`, `aiTitle?`, `entrypoint?`,
  `permissionModes?`, `effortMix?` to `SessionSummary`.

**Schema (migration 20).**
- `turns`: `effort TEXT`, `attribution_skill TEXT`, `attribution_mcp_server TEXT`,
  `attribution_mcp_tool TEXT`
- `sessions`: `session_kind TEXT`, `ai_title TEXT`, `entrypoint TEXT`
- new `session_hook_runs` (`session_id`, `ts`, `command`, `duration_ms`) for
  `hookInfos` — a table, not a column, because it is one-to-many per session
- new `session_permission_modes` (`session_id`, `ts`, `mode`) for the
  `permission-mode` timeline
- `tool_uses`: `denial_kind TEXT`
- indexes: `turns(effort) WHERE effort IS NOT NULL`,
  `turns(attribution_mcp_server) WHERE attribution_mcp_server IS NOT NULL`
- **no change to `session_prs`** (`schema.sql:620`) — it already has the right
  shape; A5 only changes what writes into it

**Version bumps.** `schema_version` → 20; `DERIVED_VERSION` 12 → **13**.

**Also update:** `src/lib/db/ingest.ts` (write path), `src/lib/data/*FromDb.ts`
(read path), `src/lib/sqlSchemaSnapshot.ts`, `src/lib/demo/sessions.ts` fixtures.

**Tests.** Fixture JSONL containing each new entry type and each new field;
assert parity between the DB path and `MINDER_USE_DB=0`; assert a **legacy**
fixture with none of the fields parses to `undefined` (not a default value) and
renders without crashing.

**Risk.** Medium — the `DERIVED_VERSION` bump re-parses all history. Measure and
report the re-index wall-clock in the PR. Confirm the migration is idempotent and
that a mid-migration abort leaves a recoverable DB (the quarantine path at
`migrations.ts:848-875` should already cover this; verify, don't assume).

## A2 — Effort analytics

The headline. `effort` is on 6979 assistant turns already, retroactively.

- `/usage` and `/costs`: an **Effort** breakdown alongside by-model / by-category.
- Cross-tab effort × one-shot rate — the question worth answering is *"does `high`
  actually buy a better outcome, or just a larger bill?"* `oneShotDetector.ts`
  already computes the success side; this joins it to the spend side.
- Per-session effort mix chip on `SessionsBrowser` / `SessionDetailView`.
- Explicit **Unknown** bucket for pre-2.1.212 turns, labelled as such — never
  folded into `medium`.

## A3 — `sessionKind` segmentation

2.1.212 added `interactive` / `attached` / `unattended` (observed value: `"bg"`).
Minder currently pools human sessions and unattended agent runs, which skews every
average it reports — a `/costs` figure that mixes a supervised session with an
unattended background run is not comparing like with like.

- Filter + facet on `/sessions`, `/costs`, `/background`.
- Segment the portfolio stats so "cost per session" is reported per kind.
- Feeds A6's efficiency grades: an unattended run's one-shot rate is a different
  metric from a supervised one's.

## A4 — Authoritative attribution

Replace inference with the explicit fields, per the semantic distinction above.

- **Cost attribution** (`turns.attribution_mcp_server` / `attribution_skill`) →
  drives per-server and per-skill spend on `/usage`, `/skills`, `/agents`.
- **Call counts** keep using `tool_uses` inference — unchanged.
- `src/lib/usage/mcpParser.ts:38` (`groupMcpCalls`) stays for counts; add a
  parallel cost-attribution path rather than overloading it.
- **Report the delta.** The PR should state how much per-server cost attribution
  moved versus the old inference. That number is the evidence the bug was real; if
  it is ~0, say so plainly rather than claiming a fix.
- Fall back to inference when the fields are absent (older sessions), and mark
  which method produced each figure so the two are never silently mixed in one
  chart.

## A5 — Authoritative PR linkage

`src/lib/usage/prExtractor.ts` currently regex-scrapes PR URLs out of turn text.
The CLI now emits dedicated `type:"pr-link"` entries (788 observed) carrying
`prNumber`, `prUrl`, `prRepository` as structured data.

- Prefer `pr-link` entries; keep the regex as fallback for older sessions.
- Same `session_prs` table, same `PrLink` type, same downstream consumers
  (`sessionsListFromDb.ts:404`, `sessionDetailFromDb.ts:256`,
  `ProjectDetail.tsx` `prSessionLinks`) — **only the source changes**.
- Picks up two upstream fixes for free: 2.1.222 links PRs created *after* the
  branch was pushed and via the GitHub REST API — both cases the regex misses
  because no PR URL ever appears in the transcript text.
- Interacts with the *Cloud session ingest* TODO entry, which names the dangling
  `prSessionLinks` cross-link as a known gap. This narrows that gap for local
  sessions; it does not close the cloud half.

## A6 — Hook performance + permission analytics

- `hookInfos` carries `{command, durationMs}` — real **hook latency** data.
  Surface slowest hooks per project; a 1450 ms `codegraph sync` on every prompt is
  exactly the kind of self-inflicted latency this dashboard exists to expose.
  Feeds the existing `get-hook-activity` MCP tool.
- `hookErrors` / `preventedContinuation` — hooks that *blocked* a turn.
- `toolDenialKind` (e.g. `automode-blocked`) + the `permission-mode` timeline →
  a denial breakdown. Note 2.1.216 fixed CC's own telemetry miscounting permission
  denials as user rejections; Minder should count them separately from the start.
- `promptSource` (`typed` vs other) — distinguishes human-typed prompts from
  replayed/scheduled ones, which matters for every "per prompt" metric.

**Optional extra:** `aiTitle` (1367 entries). Minder generates its own
`sessions.generated_title`. The CLI's title is free and already written. Prefer
`aiTitle` when present, keep generation as fallback, and skip the generation cost
entirely for sessions that have one.

---

# Wave C — new surfaces

## C1 — `.claude/workflows/` catalog

The `Workflow` tool persists scripts under `.claude/workflows/`; 2.1.219 added a
`workflowSizeGuideline` setting. Minder indexes agents, skills, commands, and
plugins but has no workflow walker.

- New `src/lib/indexer/walkWorkflows.ts`, mirroring `walkSkills.ts` /
  `walkCommands.ts` (same provenance + canonicalize + frontmatter machinery).
- Parse the `export const meta = {name, description, whenToUse, phases}` literal.
  It is a pure literal by contract, so a conservative parse is safe — but it is
  **JavaScript, not frontmatter**, so this needs its own extractor. Do not attempt
  to execute the script; parse statically and fail soft on anything unexpected.
- `GET /api/workflows`, `GET /api/workflows/[id]`, `WorkflowsBrowser` at
  `/workflows`, per-project tab — same shape as the skills catalog.
- New `FeatureFlagKey` `workflowCatalog` (default on), added to
  `FEATURE_FLAG_KEYS` (`src/lib/featureFlags.ts:6`), `FEATURE_FLAG_META`, and the
  `FeatureFlagKey` union in `src/lib/types.ts`.
- Join to usage stats the same way agents/skills do.
- **Note the name collision:** `src/lib/scanner/cicd.ts` already uses "workflows"
  for GitHub Actions. Namespace the new type explicitly (`ClaudeWorkflowEntry`) to
  keep the two apart.

## C2 — Runaway-delegation guardrails

2.1.212/217 introduced hard caps: 200 subagent spawns/session, 200 web
searches/session, 20 concurrent (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), spawn
depth 3, and `--max-budget-usd`. These are a genuinely new failure mode: a session
can now be *silently truncated* by a cap rather than finishing.

- Minder already parses subagent trees (`subagentEnrichment.ts`, `agentView/`).
  Compute spawn count and max depth per session; badge sessions approaching or
  hitting a cap.
- Feed the existing `notificationRules` engine so "session hit the subagent cap"
  is expressible as a rule.
- Surface on `/background` and `/swarms`, where the caps actually bite.

## C3 — OTEL correlation attributes

2.1.214 added `message.uuid`, `client_request_id`, and `tool_source` to OTel log
events; `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` configures the 60 KB truncation cap.
Zero references in `src/`.

- `tool_source` gives tool **provenance** (built-in vs MCP vs plugin) directly,
  instead of inferring from the `mcp__server__tool` name — the OTEL-side twin of A4.
- `message.uuid` lets `src/lib/db/otelQueries.ts` join telemetry rows to specific
  transcript turns, which is the missing key between the two data sources today.
- Ingest in `src/lib/db/otelIngest.ts`; needs its own small migration (21).
- Also fix-adjacent: 2.1.216 corrected the Prometheus exporter's invalid `# UNIT`
  lines — verify Minder's Prometheus path isn't compensating for the old bug.

## C4 — Hook + skill frontmatter parity

Small, mechanical, no schema change.

- Add `DirectoryAdded` (2.1.219) to the hook-event list — it appears in
  `src/lib/hooks/payload.ts`, the notification rule fields, `SetupGuide.tsx`, and
  the settings UI.
- `src/lib/indexer/parseFrontmatter.ts`: accept `yes`/`no`/`on`/`off`/`1`/`0`
  case-insensitively as booleans (2.1.218). **A skill using `on` instead of `true`
  currently parses wrong** — this is a live bug, not just a gap.
- Parse new skill frontmatter keys: `context: fork`, `background`,
  `disable-model-invocation`, `effort`, `model`. Surface `disable-model-invocation`
  in the catalog — it changes how a skill can be invoked, which is exactly the kind
  of thing the skills browser exists to show.
- Plugins now accept `"."` as a `skills` path (2.1.218) — verify `walkPlugins.ts`
  handles a plugin-root `SKILL.md`.

---

## Risks and rejected alternatives

- **Full re-parse cost (A1).** One `DERIVED_VERSION` bump for the whole A wave.
  If the re-index proves too slow to be acceptable, the fallback is a
  forward-only decode (new fields populate on next natural ingest, history stays
  blank) — but that forfeits the retroactive analytics that make A2 worth doing,
  so treat it as a last resort and measure before deciding.
- **Rejected: defaulting absent `effort` to `medium`.** Would silently fabricate a
  distribution across ~all pre-2.1.212 history. Unknown stays unknown.
- **Rejected: replacing `tool_uses` inference with the attribution fields.**
  Different semantics (see above). Both stay; they answer different questions.
- **Rejected: guessing fast-mode pricing.** If the transcript does not mark it,
  document the gap rather than mispricing.
- **Upstream churn.** These fields are undocumented transcript internals and can
  change without notice. Every reader must treat them as optional and degrade to
  today's behaviour — the same discipline `githubActivityCache` uses for `gh`.
- **Windows/build gates.** Anything touching `src/` needs `pnpm build`; run it in
  the background, never pipe it, and only one at a time.

## Documentation

Per the repo's Documentation Policy, each shipping slice updates `/docs/help/`,
copies to `public/help/`, adds `lib/help-mapping.ts` entries for new routes
(`/workflows`), and lands a `CHANGELOG.md` entry under `[Unreleased]` — all of
these change UI behaviour, API schema, or validation outcomes.
