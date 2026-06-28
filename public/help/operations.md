# Operations

The Operations panel gives each project one operational view: **where it deploys, what it depends on, what runs on a schedule, and what to do when it breaks.** Most of it is assembled from detection Minder already performs; the rest comes from a short, curated runbook you write.

You'll find it as the **Ops** tab on a project's detail page. The tab appears whenever there's anything operational to show (a deploy target, a service, a database, a schedule, a dependency-update config, or an `OPERATIONS.md` runbook).

## What's auto-detected

These rows are derived — with no extra scanning — from config Minder already reads:

- **Deploy targets** — hosting platforms found in your repo (`vercel.json`, `railway.toml`, `fly.toml`, `render.yaml`, `netlify.toml`, `Procfile`/`app.json`, `Dockerfile`), with any detail (framework, region, base image).
- **Services** — external services inferred from `.env*` key names (Stripe, Supabase, Resend, Clerk, Sentry, …) plus any managed-database provider detected from your `DATABASE_URL` host.
- **Database** — type, host, and port parsed from `DATABASE_URL` / `DB_URL` / `MONGODB_URI`, tagged with a managed provider when the host matches one: **Neon** (`*.neon.tech`), **PlanetScale** (`*.psdb.cloud`), **Supabase** (`*.supabase.co`), **Upstash** (`*.upstash.io`), **Railway**, **Render**. Self-hosted hosts show no provider.
- **Schedules** — cron jobs from both Vercel (`vercel.json` `crons`) and GitHub Actions (`on.schedule[].cron`), merged into one list and tagged by source.
- **Dependency updates** — Dependabot ecosystems from `.github/dependabot.yml`.

> Auto-detection always runs — it isn't gated by a feature flag. Only reading the curated `OPERATIONS.md` runbook is gated (by **Scan OPERATIONS.md**, Settings → Features, on by default).

## The curated runbook: OPERATIONS.md

The ~30% of operational truth that can't be auto-detected lives in an `OPERATIONS.md` file in the project root. Minder reads it during the scan and shows it in the Runbook section of the panel. It recognizes five sections by heading (tolerant of synonyms — `## Disaster Recovery` maps to Restore, `## Alerting` to Monitoring, and so on):

1. **Backups** — what's backed up, how often, retention.
2. **Monitoring & Alerting** — dashboards, uptime checks, who/what gets paged.
3. **On-call & Escalation** — who's responsible, escalation path, incident contacts.
4. **Secrets & Rotation** — where secrets live and how/when they're rotated.
5. **Restore & Recovery** — the step-by-step procedure for bringing things back.

Any section the panel doesn't recognize is kept verbatim under its own heading (nothing is silently dropped). For each of the five expected facts that's **missing**, the panel shows a muted "not documented — add to `OPERATIONS.md`" row, and a coverage line ("N of 9 operational facts captured") nudges you to fill the gaps.

### Format

```markdown
# Operations — my-app

## Backups
Postgres is on Neon with daily automated snapshots.
- [x] Nightly snapshot enabled
- [ ] Quarterly restore drill
  Last drill: 2026-03. `pg_restore` from the latest PITR snapshot.

## Monitoring & Alerting
- [ ] Wire uptime check (BetterStack) → #ops-alerts

## On-call & Escalation
Primary: me. Escalate to the hosting provider's support for infra outages.

## Secrets & Rotation
- [ ] Rotate STRIPE_SECRET_KEY quarterly

## Restore & Recovery
1. Restore the database from the latest snapshot.
2. Redeploy the latest green build.
```

Checkbox items (`- [ ]` / `- [x]`) are recorded with their state; indented lines beneath an item are its detail. Prose under a heading is kept as the section body. v1 is **read-only** — Minder shows the runbook but doesn't edit it.

## Living checklist: OPERATIONS.archive.md

Like `TODO.md` / `MANUAL_STEPS.md` / `BOARD.md`, `OPERATIONS.md` is a **living checklist**, not an append-only log. When a runbook item is done or obsolete, move it into a companion `OPERATIONS.archive.md` (committed for the record, but ignored by the scanner so the active runbook stays focused) rather than deleting it. Don't remove something you can't confirm is done — surface the uncertainty instead.

## Worktrees: edit the canonical main-tree file

`OPERATIONS.md` is **project-scoped, not branch-scoped**. If you (or an agent) are working inside a git worktree (a `…--claude-worktrees-…` directory), record operational facts in the **canonical main-tree** project's `OPERATIONS.md` — the parent checkout — not the worktree copy, so the runbook doesn't fragment into per-branch copies that are invisible until merge.
