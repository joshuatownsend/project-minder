# Contributing to Project Minder

Thank you for your interest in Project Minder! This is primarily a personal tool, but contributions from others are welcome.

## Getting started

1. **Clone** the repo and install dependencies:

   ```sh
   git clone https://github.com/joshuatownsend/project-minder.git
   cd project-minder
   corepack enable        # use the pnpm version pinned in package.json
   pnpm install
   pnpm setup-hooks   # installs the pre-commit hook
   pnpm dev           # starts on http://localhost:4100
   ```

2. The dashboard auto-scans `C:\dev\*` (or the `devRoot` in `.minder.json`). Point it at a directory with a few projects to get real data.

## Pre-commit requirements

The pre-commit hook runs `pnpm typecheck && pnpm test -- --pool=forks` before every commit. Both must pass. Set it up once with:

```sh
pnpm setup-hooks
```

If you skip this, CI will still catch failures — but local failures are faster to iterate on.

## Branching convention

- Never push directly to `main`.
- Create a feature branch (e.g. `wave12-fix-palette`) and open a PR.
- PRs are **squash-merged**. Keep the squashed commit message clear — it's what lands in `git log`.

## CHANGELOG discipline

All user-visible changes go under `## [Unreleased]` in `CHANGELOG.md`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Use **Added / Changed / Fixed / Removed / Internal** sub-headings. Reference the TODO number when one exists (e.g. `TODO #44`).

Pure refactors and test-only changes do not need a CHANGELOG entry.

## Writing tests

- Every new module in `src/lib/**` must have a `tests/<module>.test.ts`.
- API routes need tests when validation is non-trivial.
- Visual components are verified manually and through `pnpm build`.
- Run `pnpm test` before opening a PR. The pre-commit hook enforces this but running it manually surfaces failures faster.

## Signed commits

To sign commits with **GPG**:

```sh
gpg --gen-key
git config --global user.signingkey <KEY_ID>
git config --global commit.gpgsign true
```

To sign with **SSH**:

```sh
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

See [GitHub's signing docs](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits) for the full flow including registering the key with GitHub.

## Finding your way around

| Path | What's there |
|------|-------------|
| `TODO.md` | Open backlog, organized by wave |
| `INSIGHTS.md` | Architecture decisions and lessons learned |
| `CLAUDE.md` | Instructions for AI coding assistants |
| `docs/help/` | User-facing help docs (mirrored to `public/help/`) |
| `src/lib/` | All business logic — no UI imports allowed here |
| `src/components/` | React components |
| `src/app/` | Next.js App Router pages and API routes |
| `src/lib/scanner/` | Project-scanning modules (one per data source) |
| `src/lib/db/` | SQLite schema, migrations, and ingest |

## Reporting bugs

Open a [GitHub Issue](https://github.com/joshuatownsend/project-minder/issues) using the **Bug Report** template. Include the dashboard route, browser, OS, any console errors, and reproduction steps.

For **security issues**, see [SECURITY.md](./SECURITY.md) — please don't use a public issue.

## Questions

Check [`TODO.md`](./TODO.md) and existing issues before opening a new one. If neither helps, open a [Discussion](https://github.com/joshuatownsend/project-minder/discussions).
