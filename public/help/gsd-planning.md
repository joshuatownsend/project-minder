# GSD Planning

Project Minder can read `.planning/` directories produced by the [GSD skill family](https://github.com/anthropics/claude-code/tree/main/src/lib/skills) and surface per-project roadmap state as a **Planning** tab on the project detail page.

## What it shows

| Element | Source |
|---|---|
| Project name & description | `.planning/PROJECT.md` — first heading and first paragraph |
| Completion bar | Phase count from `phases/*.md`, status from `STATE.md` |
| Status badge | `STATE.md` YAML `status:` field |
| Milestone | `STATE.md` YAML `milestone:` field |
| Phase list | `.planning/phases/*.md` files, sorted by leading number |
| Per-phase status | `STATE.md` YAML `phases[].status` |
| Per-phase token budget | `Token budget:` line in each phase file |
| Per-phase cost | Sessions whose time window overlaps the phase (requires explicit `startedAt`/`endedAt` in `STATE.md`) |

## Cost chips

Cost chips only appear for phases that have **explicit ISO timestamps** in `STATE.md`:

```yaml
---
phases:
  - number: 1
    status: completed
    startedAt: "2026-01-01T00:00:00Z"
    endedAt:   "2026-01-02T06:00:00Z"
---
```

Phases without timestamps render normally — they just won't show a cost chip. File modification times are intentionally ignored because `git checkout` rewrites them and would attribute incorrect session costs.

## Enabling / disabling

The Planning tab is gated behind the **GSD planning scanner** feature flag (Settings → Feature Flags). It is on by default and can be turned off to hide the tab across all projects.

The tab only appears for projects that have a `.planning/` directory with at least one phase file.

## `.planning/` directory layout

GSD produces this structure automatically during project setup:

```
.planning/
  PROJECT.md          # project name + description
  ROADMAP.md          # high-level checklist (fallback completion count)
  STATE.md            # YAML frontmatter: status, milestone, per-phase timing
  phases/
    1-design-PLAN.md
    2-build-PLAN.md
    3-verify-PLAN.md
```

## Data freshness

Scan data is cached for 5 minutes. The Planning tab API response is separately cached for 5 minutes per project. Force a rescan from the dashboard to clear both caches.
