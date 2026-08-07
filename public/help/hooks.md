# Hooks

The Hooks browser shows every hook entry across all your projects and your user-scope Claude config, organized by source scope.

## Coverage matrix

The four stat cards at the top summarise coverage at a glance:

| Card | What it counts |
|---|---|
| **Project** | Hooks in `.claude/settings.json` inside a project directory |
| **Local** | Hooks in `.claude/settings.local.json` (per-machine, not shared in git) |
| **User** | Hooks in `~/.claude.json` or `~/.claude/settings.json` (apply everywhere) |
| **Events** | Number of distinct event types across all hooks |

Plugins can also ship their own hooks via `<installPath>/hooks/hooks.json`; these surface with a **plugin** provenance badge and are read-only (they cannot be modified from the dashboard).

Click a scope card to filter the list to that scope.

## Row anatomy

Each row shows:
- **Event chip** — the hook trigger (e.g. `PreToolUse`, `PostToolUse`, `SessionStart`)
- **Matcher** — the tool or event pattern (e.g. `Edit|Write`)
- **Command preview** — the first 60 characters of the command
- **local** badge — shown when the hook lives in `settings.local.json`; copying it via Template Mode auto-promotes it to `settings.json` (project-shared)
- **Source badge** — project name (links to the project detail page) or "user" for global hooks
- **↗ apply** button — appears for project-scope hooks (including local-scope) and user-scope hooks; copies the hook definition to another project
- **disable / enable** button — appears for `user` and `local` scope rows; removes the entry from `settings.json` / `settings.local.json` and stashes the original in `~/.claude/.minder/disabled-hooks.json` so re-enable restores byte-equal at the original position
- **edit settings.json** chip — appears on `project` scope rows. Project-shared hooks live in a git-tracked file, so the dashboard intentionally refuses to mutate them. Claude Code has no `disabledHooks` runtime affordance (hooks are additive — `settings.local.json` cannot shadow them), so the only way to disable a project-shared hook is to edit `.claude/settings.json` directly

## Disabled stash

When you disable a `user` or `local` hook, the entry moves to a "Disabled (N)" section beneath the active rows. Click **enable** on a stashed entry to re-insert it at its original event index and matcher-group index (clamped if the surrounding tree has shifted). The stash file is `~/.claude/.minder/disabled-hooks.json`; it survives Claude Code restarts.

## The `/config` Hooks tab

The `/config?type=hooks` tab on the Config page mirrors the toggle behavior above for parity. The top-level `/hooks` page shows the full cross-project view with virtualized scrolling; the `/config` view is non-virtualized and adds scope + effective-state badges + the `↗ apply` button for template mode.

## Filtering

| Control | Effect |
|---|---|
| Search | Matches event, matcher, command text, project name (debounced 300ms) |
| Source dropdown | Filter to `project`, `local`, or `user` scope |
| Sort | By event name (A–Z) or by project name |

## Which hook events Minder accepts

`POST /api/hooks` accepts every lifecycle event Claude Code documents — all 31,
from `SessionStart` through `SessionEnd`. Minder previously knew only 9, and an
event outside that set was rejected with a 400, so a hook wired to
`PostCompact`, `SubagentStart`, `PermissionDenied`, `FileChanged`,
`DirectoryAdded` or any of the other newer events sent its payload and had it
thrown away.

Accepting an event and modelling its payload in detail are separate things:

- **Modelled in detail** — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
  `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`,
  `SessionEnd`, `DirectoryAdded`. Their known fields are parsed into typed
  values that the background-activity and notification surfaces read.
- **Captured generically** — every other event. Timing, session and event name
  are recorded along with the raw body, which is enough for a notification rule
  or an activity trace. Fields are kept raw rather than projected into invented
  names, so nothing looks like a populated column that is always empty.

Notification rules and the ingest route derive their accepted-event lists from
one shared constant. They used to be two hand-maintained copies, which could
drift into a state where a rule could be saved for an event the route would
reject — a rule that validates and can never fire.

## Hook latency

Claude Code records how long each hook took, and Minder reads it from two places:

| Source | Needs | Covers | Names hooks by |
| --- | --- | --- | --- |
| OTEL | telemetry enabled | since you enabled it | hook name (`PreToolUse`) |
| Transcript | nothing | all history, retroactively | the command that ran (`codegraph sync`) |

OTEL is preferred when present. Otherwise the transcript path answers, and the
result says which via a `source` field — the two are never blended, because they
key on different things and merging them would count the same execution twice
under two labels.

**A hook with no recorded duration counts as a fire but contributes no
percentile.** Claude Code records a command without a duration for roughly a
fifth of hook executions. That is "not measured", not "instant" — treating it as
0 ms would rank the unmeasured hooks as the fastest on the machine. Such a hook
shows `—` rather than a number, and its row reports how many of its fires were
actually timed.

Hook *failures* are recorded separately. They arrive as a plain list of messages
alongside the run list rather than as a field on each hook, so a failure cannot
be pinned to a specific command; Minder records what is actually known — when it
happened, what it said, and whether it stopped the turn continuing.

### Where to see it

| Surface | Question it answers |
| --- | --- |
| **Stats → Telemetry → Hook Activity** | Which hooks are slow across all my work? Ranked by fire count, with a badge naming the source. |
| **Session detail → Hooks tab** | What did hooks cost *this* session? Ranked by total time. |
| `get-hook-activity` (MCP) | Either pipeline, named explicitly — `source: "transcript"` is the only way to read transcript-derived runs on a machine where OTEL always wins the card. |

The per-session **Hooks** tab appears on any session that recorded a hook run or
a hook failure. It groups runs by command and ranks them by total measured time —
the session's actual time sinks, which is not the same ordering as fire count.
Each row shows runs, total, p50 and max; when only some runs were timed, the row
says so (`12 (9 timed)`) and the untimed ones are excluded from every statistic.

Failures are listed below the table, with a **blocked the turn** row styled
distinctly from an **advisory** one — they differ in consequence, so they differ
in appearance. The rows carry no command, because the underlying data genuinely
cannot attribute a failure to one.

## Permission denials

When a tool call is refused, Claude Code records *why*. Minder groups denials by
kind and, where the data allows, crosses each with first-pass success — so you
can see whether being refused actually derails the work or the model simply
routes around it:

| Kind | Meaning |
| --- | --- |
| `permission-rule` | A configured rule refused it |
| `automode-blocked` | The auto-mode classifier refused it |
| `automode-unavailable` | Auto mode could not decide |
| `user-rejected` | A person said no |

**`user-rejected` is counted separately from the rule denials on purpose.** They
mean opposite things — a rule denial is configuration you can change, a human
rejection is you disagreeing with the model — and Claude Code 2.1.216 had to fix
its own telemetry for miscounting one as the other. Collapsing them turns "I said
no" into "your rules are too strict".

A kind that has never occurred reports *no data* rather than zero. "Nothing was
ever refused" and "this index predates the field" are different claims, and only
one of them is a clean bill of health.

### Expect the first-pass column to be absent

The cross needs a turn that both had a call denied *and* recorded a task
outcome. Task outcomes are written for well under 1% of turns and denials are
rare, so on a typical index the two never coincide and **no kind has a
first-pass figure at all** — on the reference machine, zero of 43 denials
overlapped.

When that happens the column is dropped entirely and the card says so once at
the foot, rather than printing a placeholder on every row: a dash per kind reads
as a measurement still in progress, when the truth is that this particular cross
has nothing to join against. A kind that *does* have a sample shows its real
rate, including a genuine **0%** — a kind whose denied turns always went on to
need a retry is exactly the signal worth surfacing, and it must not be swallowed
by the same branch that handles missing data.

Shown as the **Permission Denials** card in `Stats → Telemetry` — one of the two
cards there that needs no OTEL, since `denial_kind` comes from transcript
ingest. Also available through the MCP tools `get-hook-activity` and
`get-denial-breakdown`.

## Background activity (T2.3)

The **/background** page aggregates `background_tasks` and `session_crons` arrays emitted by Stop / SubagentStop hook events as of Claude Code v2.1.145. Use it to see what long-running shell commands or scheduled tasks are pending across your portfolio.

**Data source.** When Claude Code finishes a turn (Stop) or a subagent completes (SubagentStop), the hook payload includes the current set of background tasks and session crons. Project Minder's hook receiver parses these arrays into the in-memory ring buffer keyed by project slug; the `/background` page reads from there.

**Freshness rule.** The aggregator only considers Stop / SubagentStop events received in the last 5 minutes. Older events are ignored on read even if they're the only data we have, so the page never claims something is "current" when its last signal was hours ago. The underlying ring buffer is count-capped at 50 events per project and is not time-evicted at write time, but for the purposes of this surface the older entries effectively don't exist.

**Snapshot semantics.** Each Stop hook carries a *snapshot* of background tasks and crons at that moment. An explicit `background_tasks: []` on the latest Stop is treated as authoritative — a task finishing clears the surface, it doesn't fall back to an older non-empty payload. Pre-v2.1.145 Stops that omit both keys entirely are treated as "no info" and skipped, so they don't shadow a prior payload that did carry data.

**Lies-by-omission caveat.** A long-running background task whose session hasn't fired a Stop event in the last 5 minutes won't appear here, even if the underlying OS process is still running. SQLite-backed retention is a planned follow-up.

**Field shape.** The inner shape of each `background_tasks` / `session_crons` entry isn't published in the public Claude Code docs as of v2.1.150, so the page renders whatever fields the payload carries via defensive runtime narrowing — every own-key + stringified value. If Claude Code adds, renames, or drops fields, the page keeps working (no schema break).

## Tool approval gate (default off)

Enable **Tool approval gate** in Settings → Feature flags to hold Claude's tool calls until you approve them — from the dashboard, or from a phone on your LAN.

It works through Claude Code's `PreToolUse` hook, which is synchronous: the tool call waits for the hook process to exit, and Claude reads the decision from its output. Minder holds the request open, shows you what's about to happen, and writes your answer back.

**You need the hook installed, not just the flag on.** The blocking hook is written into `~/.claude/settings.json` by **Install hooks** on the Setup page, alongside the ordinary activity hook — flipping the feature flag alone does nothing if hooks were never installed. If you installed Minder's hooks *before* this feature existed, re-run **Install hooks**: it adds the missing entry and leaves everything else untouched. The Setup page reports this separately from "hooks installed" so you can tell the two states apart.

The flag itself is read on every request rather than at install time, so you can turn the gate on and off in Settings without reinstalling anything. While it's off, the hook posts, gets "no opinion" back, and Claude prompts you exactly as it normally would.

### What you'll see

An approval card naming the tool and a one-line summary of what it will do — the actual command for a shell call, the path and size for a write, the URL for a fetch. Answer **Allow**, **Allow all**, or **Deny**.

**Allow all** applies to that session only, so leaving one long run unattended doesn't disarm the gate for everything else you're running.

### What it will never do

- **It will never block you if something goes wrong.** If Minder isn't running, the server errors, or you simply don't answer within 60 seconds, the tool call falls back to Claude's normal terminal prompt. The gate never denies on its own — only an explicit **Deny** does that. Not answering is not the same as saying no.
- **It will never approve a stale request.** A decision only counts while that exact call is still waiting. If you tap a notification after it timed out, you'll get "no longer waiting" rather than silently approving whatever is waiting *now*.
- **It will never pile up more than 50 waiting calls.** Past that, further calls fall back to the normal prompt instead of queueing behind ones you haven't answered. A queued call would be blocked while being invisible to you.

### What isn't gated

Read-only tools pass straight through, because gating them would add a round-trip to every file read for no benefit: `Read`, `Grep`, `Glob`, `LS`, `NotebookRead`, `TodoRead`.

Everything else is gated, including some things you might expect to be exempt:

- **`Bash`** — the most important one to gate; it can do anything.
- **`WebFetch` / `WebSearch`** — they don't change anything locally, but they *send data out*, and a URL can carry information off your machine.
- **MCP server tools** — a third-party tool named like a read may not be one.
- **Anything new** — the pass-through list is a fixed allowlist, so a tool added to Claude Code in a future release is gated until it's explicitly reviewed.

Bypassing Minder's gate doesn't bypass your own Claude Code permission settings — a read you'd normally be asked about still prompts as usual.

### Privacy

Approval prompts stay on your machine. The endpoint is served from Minder's own local port, and phone approval works over your LAN. Nothing is routed through a third-party push relay, and no token is embedded in a notification payload.
