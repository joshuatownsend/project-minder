# Demo mode

**Demo mode** fills the entire dashboard with realistic **synthetic data** — projects, sessions, token usage, boards, insights, manual steps, agents, skills, and the activity strips — so Minder looks alive on a fresh machine with no real `~/.claude` history or `C:\dev` project tree. It's built for **first-run tours, marketing screenshots, and live demos**.

## What you see

With demo mode on, every read surface is served from fixtures instead of your filesystem:

- **Home / Projects** — a portfolio of ~8 projects across active, paused, and archived, each with a stack, git status, and Claude session counts.
- **Sessions & Usage/Cost** — a spread of sessions with timelines and one-shot rates, and a cost report with by-model / by-category / by-day breakdowns.
- **Board · Insights · Manual steps · Ops** — populated on the projects that have them.
- **Agents & Skills** — a small catalog with usage stats.
- **Activity strips** — GitHub PRs/CI, git dirty counts, MCP server health, and the burn HUD all render.

The data is **deterministic** (stable across runs, so screenshots are reproducible) but **anchored to "now"**, so relative times ("2h ago", "today") always look fresh.

## Turning it on

Two independent switches — either one activates demo mode:

- **Env var** — set `MINDER_DEMO=1` before starting the server (`pnpm dev` / `pnpm start`). No config is written; this is the switch for CI, screenshot capture, and first-run. Mirrors the `MINDER_USE_DB` env-toggle idiom.
- **Settings toggle** — flip **Demo mode (synthetic data)** under **Settings → feature flags**. Off by default; persisted in `.minder.json`. Best for a live demo you want to click into and back out of.

After toggling the Settings flag, use **Rescan** (or wait out the ~5-minute scan cache) so the projects surface refreshes; a hard reload refreshes the rest.

## What it does *not* do

- It's **read-only synthetic data** — no files are created, and none of your real projects, sessions, or credentials are touched or exposed.
- Writes (toggling a real manual step, editing a board, launching a workflow) aren't meaningful against fixtures and are blocked with a "read-only in demo mode" notice.
- The per-project **Hot Files**, **Errors**, and **Patterns** tabs are **hidden** for demo projects: they analyze real session JSONL keyed on the actual project path, which the fixtures don't provide, so they'd otherwise render empty. The **Efficiency** tab still renders.
- Turn it off (unset the env var / flip the flag off) to return to your real data.
