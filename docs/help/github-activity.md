# GitHub Activity

The **GitHub strip** answers the three questions that usually make you switch to a GitHub tab — **are there open PRs, is CI green, and how long ago was the last push?** — right on the project card and the project detail page, without leaving Minder.

## What it shows

On each **project card** (full view), a compact row appears when there's something worth showing:

- **Open PRs** — `N PRs` in amber when there are any (hidden at zero). Clicks through to the repo's Pull Requests tab.
- **CI** — a colored dot for the latest run on the default branch: green = passing, red = failing, amber (pulsing) = running. Hidden when unknown. Clicks through to the run.
- **Pushed** — relative time of the last push (e.g. `3h ago`).

On the **project detail page**, the Overview tab gains a **GitHub** section with the same signals plus an expandable list of the open PRs (number, title, draft badge, and last-updated time). When a PR was opened during a Claude Code session, an **"opened in session →"** link appears next to it — a cross-link built from the session's recorded PR links.

## Where the data comes from

The strip is powered by the **local, authenticated [`gh` CLI](https://cli.github.com/)** — the same one you use in your terminal. Minder shells out to `gh` in the background (never interpolating untrusted values into a shell), reads:

- `gh pr list` — open pull requests
- `gh run list` — the latest workflow run on the default branch
- `gh repo view` — the last-push timestamp

…and caches the result per project for **5 minutes**. Results are fetched in small background batches when the dashboard loads and polled by the page, so the strip fills in shortly after the cards appear.

### Requirements & graceful degradation

You need `gh` installed and authenticated:

```
gh auth login
```

The strip is **quiet by design**. If `gh` is missing, unauthenticated, the remote isn't a `github.com` repo, or the directory isn't a git repo, the strip simply **does not render** — there's no error chrome on the cards and no toast spam. (The "unavailable" outcome is cached too, so a `gh`-less machine isn't re-probed on every poll.)

## Rate limits

Each repo costs up to **three `gh` calls**, which share your GitHub REST rate budget. Minder uses a gentle batch cadence to stay well within limits across a large portfolio. A future upgrade may move to a single GraphQL query per refresh for very large workspaces.

## Turning it off

The strip is controlled by the **GitHub activity** feature flag in **Settings**, which is **on by default**. Turning it off skips the background `gh` fetch entirely and hides the strip everywhere.
