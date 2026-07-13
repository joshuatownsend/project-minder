# Cost Report

The **Cost report** is a single-screen table of Claude Code spend for **every**
project, sliced by time period. Where the Home dashboard shows only your top
projects and the Usage page focuses on one aggregate view, this page ranks the
whole portfolio so you can see, at a glance, where your token budget goes.

## Opening it

Navigate to **Review → Cost report** in the sidebar (`/costs`).

## Period slices

A single active period drives the whole table. Switch it with the toggle at the
top:

- **Today** — activity since local midnight
- **7 days** — rolling 7-day window
- **30 days** — rolling 30-day window (default)
- **90 days** — rolling 90-day window
- **1 year** — rolling 365-day window
- **All time** — every recorded turn

These same six periods are available on each project's **Costs** tab (see
below). The rolling **90 days** and **1 year** windows were added for this
report and now also appear on the Usage dashboard's period switcher.

## The table

One row per project that has recorded usage in the selected period:

| Column | Meaning |
|--------|---------|
| **Project** | The project name. Rows for a scanned project link to that project's **Costs** tab. |
| **Cost** | Estimated spend for the period (per-model LiteLLM pricing, subagent spend included). |
| **Share** | That project's cost as a fraction of the period total (bar). |
| **Tokens** | Combined input + output + cache tokens. |
| **Turns** | Assistant turns in the period. |

Click any column header to sort by it; click again to reverse. Cost sorts
high→low by default. Use the **Filter projects…** box to narrow the list by
name. A totals row at the bottom sums the visible rows.

Some rows (for example a bare `C:\dev` session or a temporary directory) have
usage but no matching scanned project — these appear un-linked, since there is
no project page to open.

## Per-project Costs tab

Each project's detail page has a **Costs** tab (shown when the project has
Claude Code sessions). It uses the same six-period switcher and shows that one
project's:

- **Headline** — total cost, tokens, turns, and sessions for the period.
- **By model** — cost per Claude model (e.g. Opus vs Sonnet vs Haiku).
- **By category** — cost per activity category (Coding, Testing, Git Ops, …).

An **All projects →** link jumps back to this cross-project report.

## Cost accuracy

All figures use the same per-model LiteLLM pricing (24-hour cached, with
built-in Opus/Sonnet/Haiku fallbacks) as the Usage and Stats pages, so numbers
agree to within floating-point rounding. Subagent (Task) spend is included;
long-context tokens above the 200k boundary are billed at the higher tier; and
re-logged duplicate messages are counted once. See **Usage** for the full
accounting rules.
