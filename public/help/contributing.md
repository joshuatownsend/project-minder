# Contributing

Project Minder welcomes bug reports and pull requests. Here's what you need to know before contributing.

## Setup

This project uses [pnpm](https://pnpm.io). The version is pinned in `package.json`'s `packageManager` field — run `corepack enable` once and the right pnpm is used automatically.

```sh
git clone https://github.com/joshuatownsend/project-minder.git
cd project-minder
pnpm install
pnpm setup-hooks   # installs the pre-commit hook
pnpm dev           # dashboard runs on http://localhost:4100
```

## Pre-commit hook

`pnpm setup-hooks` writes a pre-commit hook that runs `pnpm typecheck && pnpm test --pool=forks` before every commit. Set it up once after cloning. CI enforces the same checks, but catching failures locally is faster.

## Branching and merging

- Never push directly to `main`
- Create a feature branch and open a pull request
- PRs are squash-merged — write a clear commit message for the squash

## Changelog

Add entries to `CHANGELOG.md` under `## [Unreleased]` for any user-visible change. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Tests

Every new module in `src/lib/**` needs a test file in `tests/`. Visual components are verified manually and through `pnpm build`.

## Community files

- [Code of Conduct](https://github.com/joshuatownsend/project-minder/blob/main/CODE_OF_CONDUCT.md)
- [Security policy](https://github.com/joshuatownsend/project-minder/blob/main/SECURITY.md)
- [Issue templates](https://github.com/joshuatownsend/project-minder/issues/new/choose)
