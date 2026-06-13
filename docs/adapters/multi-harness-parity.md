# Multi-harness adapter parity — gap analysis (spike)

> **Point-in-time map.** Generated 2026-06-13 against commit `1b45d2b`. The
> adapter/ingest/aggregation code drifts as harness support evolves — treat the
> cell values below as a snapshot, re-verify the cited `file:line` pointers
> before acting on them. Produced by plan 006 (investigation only; **no source
> changed**).

## TL;DR

Project Minder ships a three-harness adapter registry (claude / codex / gemini)
behind a clean `SessionAdapter` interface, and each adapter can independently
*discover* its session files and *parse* them into `UsageTurn[]`. The common
assumption "this is Claude-only and a second harness must be built from scratch"
is **false at the interface layer** — but it is **true at the data layer**.

The decisive finding: **`discoverAllSessions()` and every adapter's
`discover()` / `parseFile()` have zero callers in the data pipeline.** The
entire session/usage/agents/skills flow reads `~/.claude/projects/**/*.jsonl`
directly and hard-stamps `source: "claude"`. So Codex and Gemini support is
**plumbing that is never connected to a faucet**: the parsers exist and are
tested, but no ingest or aggregation path ever runs them. The only place
non-Claude adapters do real work today is the **read-only Codex config surface**
(`/api/adapters/[id]/config`).

This is also a **documentation-vs-reality gap**: `README.md:84-88` claims "All
analytics … apply" to Codex and that the "By Source breakdown shows cost
attribution per tool" and "sessions browser's source filter" work — but with no
ingest path feeding non-Claude turns, the By-Source breakdown can only ever
contain a single Claude row and the sessions list only ever holds Claude
sessions. (Flagged in Open Questions — not fixed here.)

## Parity matrix

Rows = the 7 surfaces from the plan. Cells = **Full** / **Partial** / **Absent**
+ a one-line `file:line` evidence pointer.

| # | Surface | claude | codex | gemini |
|---|---------|--------|-------|--------|
| 1 | **Discovery** (`discover()` finds real files) | Full — `src/lib/adapters/claude.ts:16` walks `~/.claude/projects` | Full — `src/lib/adapters/codex.ts:470` walks `~/.codex/sessions` + `archived_sessions` | Full — `src/lib/adapters/gemini.ts:210` walks `~/.gemini/tmp/<p>/chats` |
| 2 | **Per-file parse** — `parseFile` / `parseFileWithMeta` | Full — `parseFile` `claude.ts:48`; **`parseFileWithMeta` `claude.ts:53`** | Partial — `parseFile` `codex.ts:500`; **no `parseFileWithMeta`** (`codex.ts:466-535`) | Partial — `parseFile` `gemini.ts:262`; **no `parseFileWithMeta`** (`gemini.ts:206-265`) |
| 3 | **SQLite ingest** (rows in `~/.minder/index.db`) | Full — `reconcileAllSessions` walks `~/.claude/projects` `src/lib/db/ingest.ts:2208`, stamps `source:"claude"` `ingest.ts:973` | Absent — ingest never calls `discover()`/`parseFile()`; hard-wired to Claude JSONL layout (`ingest.ts:2208`, `:2233`) | Absent — same; `ingest.ts:2208` only readdir's `~/.claude/projects` |
| 4 | **Usage / cost aggregation** (turns in `generateUsageReport` + `SourceBreakdown`; priced by `costCalculator`) | Full — file path `generateUsageReport` `aggregator.ts:45` → `parseAllSessions` → `parseSessionTurns`; SQL path `getUsage` `data/index.ts:541` | Absent (turns) — `parseAllSessions` `parser.ts:531` walks `~/.claude/projects` only (`parser.ts:460`); `bySource` keys on `turn.source ?? "claude"` `aggregator.ts:295` so codex never appears. Pricing **Partial** — `getModelPricing` `costCalculator.ts:147` prices `gpt-*` only if live LiteLLM map has the exact id, else falls to Claude sonnet `costCalculator.ts:180` | Absent (turns) — identical to codex; Pricing **Partial** — same `costCalculator.ts:147`/`:180` |
| 5 | **Session detail / list UI** (`sessionDetailFromDb` / `sessionsListFromDb`) | Full — `sessionsListFromDb.ts:382` / `sessionDetailFromDb.ts:352` read `sessions.source` (source-aware) | Partial — read layer is source-aware (`sessionsListFromDb.ts:382`) but DB has no codex rows (see #3), so it surfaces nothing | Partial — same as codex (`sessionDetailFromDb.ts:352`) |
| 6 | **Agents / skills / commands catalogs** | Full — indexer walks `~/.claude/agents` `walkAgents.ts:183`, `~/.agents/agents` `:188`, plugins `:197`, project `.claude/agents` `:216` | Absent — no Codex agent/skill concept indexed (`walkAgents.ts` Claude-only paths) | Absent — same (`walkAgents.ts`, `walkCommands.ts` Claude-only paths) |
| 7 | **OTEL telemetry** | Full — `CLAUDE_CODE_ENABLE_TELEMETRY` written to `~/.claude/settings.json` `otelSettings.ts:16-23,66` | Absent — Codex emits no Claude-Code-native OTEL; install path is Claude-only (`otelSettings.ts:9,66`) | Absent — same; Gemini has no equivalent telemetry hook (`otelSettings.ts`) |

### Score by harness

- **claude**: 7/7 Full.
- **codex**: 1 Full (discovery), 2 Partial (parse-no-meta, read-layer-ready-but-empty),
  rest Absent. Pricing is a degraded-Partial sub-cell of #4.
- **gemini**: identical shape to codex.

The single load-bearing gap is **#3 (ingest)**. Because nothing routes
`discoverAllSessions()` output into ingest, surfaces #4 and #5 are Absent/Partial
purely *downstream* of #3 — wire #3 and they light up automatically (the read
and aggregation layers are already source-aware). #6 and #7 are independent gaps
(no Codex/Gemini agent or telemetry concept exists at all).

## Per-gap notes (effort estimates are coarse: S/M/L)

**#2 — `parseFileWithMeta` missing on codex & gemini (Partial).**
`parseFileWithMeta` returns `{ turns, meta: SessionTurnsMeta }` and powers
session-detail/meta surfaces; only Claude implements it (`claude.ts:53`). Today
this is *moot* because nothing calls `parseFileWithMeta` either (it's defined on
the interface `types.ts:15`, implemented once, invoked nowhere). Blast radius if
ever wired: each adapter file + whatever new detail-meta consumer is built.
**Effort: S** per adapter (mostly threading the meta the parser already has).

**#3 — SQLite ingest is Claude-hardwired (Absent for codex/gemini).**
`reconcileAllSessions` (`ingest.ts:2203`) readdir's `~/.claude/projects`
(`:2208`, `:2233`), derives `sessionId` from the filename (`:2033`), parses via
`readJsonlSession` (Claude line-delimited JSONL), and writes `source: "claude"`
literally (`:973`). The watcher's default root is the same dir
(`ingestWatcher.ts:80`). Codex's event-stream `.jsonl` and Gemini's single-JSON
`session-*.json` formats would never parse under this path even if the dir were
swapped. Blast radius: `ingest.ts` (discovery walk + per-file parse dispatch +
`source` stamping + the filename→sessionId assumption), `ingestWatcher.ts`
(watch roots), and the dedup/prune logic that assumes one Claude projects tree.
**Effort: L** — this is the keystone; it changes the indexer's core loop and its
file-identity assumptions.

**#4 — Non-Claude turns never reach aggregation (Absent); pricing Partial.**
Both backends are Claude-only at the source: the file path's `parseAllSessions`
(`parser.ts:531`) calls `buildAllSessions` which walks `~/.claude/projects`
(`parser.ts:460`) and parses with the Claude `parseSessionTurns` (`parser.ts:510`);
the SQL path reads the Claude-only DB from #3. The aggregator's `bySource`
machinery is fully built and source-aware (`aggregator.ts:295,384-385,424`) —
it just never sees a non-`claude` `source`. Pricing degrades silently: a
`gpt-5`/`gemini-2.5-*` model is priced correctly only when the live LiteLLM map
loaded and contains the exact id; offline (hardcoded `FALLBACK_PRICING`, Claude
only — `costCalculator.ts:9-23`) or on a near-miss id it falls through keyword
matching to **default Claude sonnet pricing** (`costCalculator.ts:180`), so a
non-Claude session would be mispriced rather than flagged. Blast radius: lands
almost entirely "for free" once #3 ships (turns arrive with the right `source`);
pricing hardening is a separate small change in `costCalculator.ts`.
**Effort: S** (downstream of #3) + **S** (pricing fallback for non-Claude ids).

**#5 — Session detail/list surface only Claude (Partial).**
The read modules already select `sessions.source` with a `"claude"` fallback
(`sessionsListFromDb.ts:382`, `sessionDetailFromDb.ts:352`) — i.e. they are
source-agnostic by construction and would render Codex/Gemini sessions today
*if any were ingested*. They aren't (see #3). Blast radius: none in these
modules; entirely gated on #3. **Effort: S** (verification only, post-#3).

**#6 — Agents/skills/commands are Claude-only (Absent).**
The indexer walks Claude-specific roots exclusively (`walkAgents.ts:183-228`,
`walkCommands.ts:180-219`) and parses Claude frontmatter `.md`. Codex
(`rules/`, `prompts/`, AGENTS.md) and Gemini have different "instruction/agent"
concepts entirely; there is no harness abstraction here. Blast radius: a new
indexer source per harness + catalog type changes + UI source filters.
**Effort: M-L** and arguably lower-value than session analytics — these are
different artifact models, not the same model under a different path.

**#7 — OTEL is Claude-only (Absent).**
Install/uninstall toggles six `CLAUDE_CODE_ENABLE_TELEMETRY`-family env vars in
`~/.claude/settings.json` (`otelSettings.ts:16-23,61-99`); the ingest endpoints
consume the Claude Code OTEL schema. Codex/Gemini don't emit this telemetry, so
generalizing is **not a porting task** — it depends on whether those harnesses
expose OTEL at all. Likely out of scope until upstream support exists.
**Effort: L / blocked-on-upstream.**

## Prioritized follow-up list (candidate future plans — NOT written here)

1. **Route `discoverAllSessions()` output through the SQLite ingest pipeline.**
   The keystone. Make `reconcileAllSessions`/the watcher iterate
   `discoverAllSessions(config)` (per-`SessionFile` `source` + `filePath`) and
   dispatch to the owning adapter's `parseFile`, instead of readdir'ing
   `~/.claude/projects` and assuming Claude JSONL. Unlocks #4 and #5 with little
   extra work. (L)

2. **Harden non-Claude model pricing in `costCalculator`.** Add a non-Claude
   fallback branch so a `gpt-*`/`gemini-*` id with no LiteLLM match is priced as
   "unknown" (or with a harness-appropriate fallback) rather than silently
   billed at Claude sonnet rates (`costCalculator.ts:180`). Small, valuable, and
   independent of #1. (S)

3. **Reconcile the multi-harness docs with reality (or ship #1 first).** Either
   implement #1 or correct `README.md:84-88` and `docs/help/*` so they stop
   claiming Codex/Gemini analytics work when no ingest path feeds them. Prevents
   users from trusting an empty By-Source breakdown. (S)

4. **Implement `parseFileWithMeta` for codex & gemini.** Bring the two adapters
   to interface parity so the (future) session-detail/meta consumer that #1
   enables can read non-Claude session metadata uniformly. (S each)

5. **(Lower priority) Generalize the agents/skills indexer to a harness source
   abstraction.** Introduce a per-harness catalog source so Codex `rules/` /
   `AGENTS.md` and Gemini instruction concepts can appear alongside Claude
   agents/skills. Larger and lower-leverage than session analytics; defer until
   #1 lands. (M-L)

## Open questions (could not be determined from code, or needs a product call)

- **Is per-session cost data even computable for Codex/Gemini?** The parsers do
  extract token deltas (codex `last_token_usage`/`total` subtraction
  `codex.ts:340-367`; gemini `tokens.{input,output,cached}` `gemini.ts:68-83`),
  but those numbers are only as trustworthy as the harness's own logging. The
  gemini parser explicitly flags an *assumption* that token values are per-turn
  deltas (`gemini.ts:65-67`) — if a future Gemini CLI version logs cumulative
  totals instead, costs would be massively overcounted with no error. **Format
  instability is a live risk** for both non-Claude parsers.

- **Documentation accuracy (flagged, not fixed per plan scope):** `README.md:84`
  says "All analytics … apply" to Codex and `:88` describes a working By-Source
  breakdown and sessions source filter. Given #3, these read as aspirational. Is
  the intent that #1 is imminent, or should the docs be walked back now? (A
  reviewer/product call — the spike does not change docs or `src/`.)

- **`enabledAdapters` semantics.** Today `enabledAdapters` (default `["claude"]`)
  only gates the `/api/adapters` list and the Codex config surface
  (`adapters/route.ts:10`, `adapters/[id]/config/route.ts:26`); it does **not**
  gate any session/usage ingestion (nothing reads it on those paths). After #1,
  it would gain real teeth — worth a deliberate decision on default-on vs.
  default-off for codex/gemini, and on migration of existing users' configs.

- **Filename→sessionId identity.** Claude ingest derives `sessionId` from the
  JSONL filename (`ingest.ts:2033`). Codex carries its real id in
  `session_meta.payload.id` (`codex.ts:91-93`) and Gemini in `record.sessionId`
  (`gemini.ts:106-109`). #1 must thread the adapter-resolved id rather than the
  filename, or cross-harness sessions could collide / mis-prune. Confirmed in
  code that this assumption exists; the fix is mechanical but easy to miss.

- **No covering tests on the wiring seams.** CodeGraph blast-radius flagged
  `aggregateUsage` (`aggregator.ts:172`) and `getEnabledAdapters`
  (`adapters/index.ts:31`) as having "no covering tests." The adapter *parsers*
  are well-tested in isolation, but the (currently nonexistent) integration of
  discover→parse→ingest has no test to anchor #1 against — a test harness would
  be the first deliverable of plan #1.
