# Timecard — human engagement

**Route:** `/timecard` · per-project tab: **Timecard**

Answers one question: *of the wall-clock time your Claude Code transcripts
span, how much did you actually spend attending to them?* That is the number
that belongs on a billable timecard. Total session span is not — an agent that
ran unattended for two hours leaves the same footprint as two hours of
supervised pair-work.

## What counts as attended

Attendance is judged **within a single session**, never across two. If one
session's agent is still working and a different session's opening prompt
arrives a minute later, that is a new conversation, not a reply — reading them
as one stream would credit an unwatched run as supervised. Running a main
checkout and a worktree side by side is the normal case here, so this matters.
Each session's credited time is then unioned across the project: two sessions
attended over the same minutes bill those minutes **once**.

Within a session, turns are sorted onto one timeline and split into two kinds:

- **Human** — a prompt you typed, a `/slash` command, or a `!bash` input.
- **Agent** — assistant turns, tool results, and machine-injected `user` turns
  (hook output, task notifications, post-compaction continuations).

Between each pair of your prompts the gap is split at the agent's last event:

```
agentBusy = lastAgentEvent − yourPreviousPrompt
quiet     = yourNextPrompt − lastAgentEvent

attended  = quiet ≤ idleThreshold
credit    = min(agentBusy, runCap) + quiet
```

The test is **`quiet`**, not the gap between your messages. Supervising a
40-minute agent run produces a 40-minute gap with you watching the whole time;
a 2-minute run you walked away from produces a 3-hour gap. Raw gap can't tell
those apart — how fast you reacted once the agent actually stopped can.

When `quiet` exceeds the threshold the block closes and the agent work inside
that gap earns **nothing** but the tail credit. Fire off a prompt at 17:00, let
a 25-minute run finish unwatched, come back at 09:00: that books the tail
credit, not 25 minutes.

Credited time stays anchored to when it happened. If a run is capped, the
surviving credit sits at the **end** of that run — the part right before you
replied — not at its start. That matters for more than tidiness: the daily
buckets and the concurrency discount below both read real instants, so credit
recorded at the wrong time lands on the wrong day or misses an overlap.

## The three thresholds

All three are sliders on the page and recompute live.

| Threshold | Default | Where the default comes from |
|---|---|---|
| **Idle threshold** | 15 min | The response-latency distribution decays smoothly but its per-minute density falls off a cliff between 10–15 min (1.08 %/min) and 15–20 min (0.32 %/min) — a 3.4× drop. Below it you're replying; above it the curve flattens into a "walked away" tail that no longer depends on elapsed time. |
| **Agent-run cap** | 30 min | p95 of observed agent-busy spans between prompts (p50 2.7, p75 8.4, p90 18.1, p95 29.8). A prompt sent 10 seconds after a 4-hour run proves you came back, not that you sat through it. |
| **Tail credit** | 3 min | Reading and verifying after your last prompt leaves no transcript event. The smallest knob: ±1 min moves a five-week total by ~2 h. |

Raising the idle threshold from 5 to 30 minutes roughly doubles the reported
hours, so the number is only as defensible as the threshold behind it. The
page and the CSV both state the values used.

## Concurrency: why per-project hours are discounted

If you worked two repos in the same minute, a naive per-project sum bills that
minute twice. Measured across this corpus, **30 % of attended time overlaps
another project**.

The report shows both numbers:

- **Raw** — attended time for that project alone.
- **Billable** — after de-overlapping. When several projects are active in the
  same instant, that instant is split evenly between them.

Per-project billable hours always sum exactly to the day's total, and the
daily totals sum exactly to the period total. That is enforced rather than
hoped for: shares are apportioned to two decimals (largest-remainder) instead
of each being rounded on its own, which is what makes three small concurrent
slices add up to their day rather than to a cent more.

## Automated sessions are excluded

Sessions whose `entrypoint` starts with `sdk-` (SDK-driven, headless, cron)
are dropped entirely — no human was in the loop. This matters more than any
text heuristic: a single cron-driven project in this corpus contributed 3,479
SDK sessions whose scripted opening prompts read exactly like human prose.

Sessions with an **unknown** entrypoint are kept. Absence of evidence isn't
evidence of automation.

## Export

**Export CSV** produces one row per (local day × project × Claude home), ready
to paste into a timecard, followed by a provenance block recording the period,
timezone, thresholds, and the overlap discount. A billable figure a client can
question should travel with the definition that produced it. The `home` column
is empty in the ordinary single-home case; it exists so two homes holding the
same project path stay distinguishable in the artifact that gets invoiced.

Credited time never runs past the moment the report was generated — tail
credit on a prompt sent minutes ago is truncated rather than booking minutes
that have not happened yet.

Day buckets follow **your browser's timezone**, not UTC — an evening's work
stays on the day you did it. The **Today** period is measured from midnight in
that same zone, so the window and its rows always agree even when the server
runs somewhere else.

Work that spans the start of the period is not lost. A gap that begins just
before the boundary and finishes inside it is reconstructed from the turns
either side, then clipped to the period — so a `Today` report still credits
the exchange you were in the middle of at midnight, but only its portion after
midnight.

## Requirements and limits

- **Claude Code sessions only.** The report is built entirely from the
  intervals *between* turns, so a source that records one timestamp per
  session rather than per turn cannot be measured — it would collapse each
  conversation to a single instant and bill the flat tail credit as if it were
  work. The Codex adapter is in that category today and is excluded rather
  than approximated.
- **Requires the SQLite index.** With `MINDER_USE_DB=0` the page reports the
  report is unavailable rather than showing an empty one, which would read as
  "you did no billable work". Reconstructing attendance needs every turn in
  the period on one sorted timeline; over raw JSONL that's millions of lines
  per request.
- **Unavailable until the index has been read through once.** The same
  reasoning, one step further: on a new install, while Minder is still reading
  your transcripts for the first time, the report refuses instead of answering.
  Anything it could say at that point is a *subset* of your work wearing the
  shape of a total, and a low number that looks true is worse than an error on a
  figure you might invoice against. The page distinguishes this from
  `MINDER_USE_DB=0`: one says "still indexing" and resolves itself, the other
  says the index is switched off.

  It applies to the **first** full pass only. Once your history has been read
  through once, later re-reads — the ordinary sweep, or a version bump that
  re-derives existing rows — do not take the report offline, because the fields
  it reads are recorded straight from your transcripts and survive a
  re-derivation. A pass that is interrupted before finishing does not count as
  that first read.
- Turns are attributed to the project directory the session ran in, so work
  done for one client from another repo's directory lands on that repo.
- Projects are identified by directory **and Claude home**, so two configured
  homes holding the same path layout stay separate rather than merging their
  hours into one row.
- Time spent away from the terminal — reading the client's spec, a call, a
  whiteboard — leaves no transcript and is invisible here. This measures
  supervised agent work, not your whole engagement.
