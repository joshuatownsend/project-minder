# Live Activity

Live Activity lets Project Minder receive real-time lifecycle events from Claude Code. When enabled and hooks are installed, project cards light up with a green **live** pulse while Claude is running, and turn amber with an **input** badge when Claude is waiting for your permission or input.

## How it works

Claude Code supports [lifecycle hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — shell commands that fire on events like `PreToolUse`, `Notification`, and `Stop`. Project Minder registers a `curl` command against six of these events. Each time Claude fires a hook, it POSTs the event payload to `POST /api/hooks` on your local dashboard.

## Security model

The hook receiver is **localhost-only**. Claude Code runs on your machine, and Project Minder's Next.js server listens on `localhost`. The registered hook URL always points to `http://localhost:<port>/api/hooks` — it is never reachable from the internet. The receiver also verifies a sentinel `User-Agent` header so only requests originating from Project Minder's registered curl command are accepted.

## Setup

1. Open **Settings → Live Activity**.
2. Toggle **Enable live activity** on.
3. Click **Install**. Project Minder will write six hook entries into `~/.claude/settings.json`:
   - `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`
4. A COW snapshot of your existing `settings.json` is saved to `~/.minder/config-history/` before any write, so you can always restore.

## Port changes

The hook URL is registered as `http://localhost:<PORT>/api/hooks` where `<PORT>` is the port you were on when you clicked Install. If you later change ports, the Settings page will show a **Reinstall** button — click it to update the registered URL.

## Awaiting-permission alerts

When Claude Code fires a `Notification` event (it needs your input), the dashboard:
- Shows an amber **input** badge on the project card
- Fires a browser toast notification
- Optionally sends a push notification (mobile) or Telegram message

Configure these channels under **Settings → Live Activity → Awaiting-permission alerts**.

## Removing hooks

Click **Remove** in Settings → Live Activity. Project Minder identifies its own entries by a sentinel string embedded in the `curl` command and removes only those — your other hook entries are untouched.

## Troubleshooting

- **Cards don't light up**: Check that the feature flag is enabled (Settings → Features → Live activity) and hooks are installed.
- **Hook install fails**: Ensure `curl` is available in your PATH. On Windows 10+, `curl` ships with the OS. On older Windows, install via `winget install curl.curl`.
- **Wrong port after port change**: Click Reinstall in Settings → Live Activity.
- **Restore after a bad write**: Find the snapshot in `~/.minder/config-history/` and copy it back to `~/.claude/settings.json`.
