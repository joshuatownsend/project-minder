# Notifications

Project Minder can alert you when a new manual step is added to any project's `MANUAL_STEPS.md`, when a session is waiting on you, or when any **notification rule** you define matches a live hook event — all while the dashboard tab is closed.

## Setup

1. Go to **Settings → Notifications**.
2. Click **Enable browser notifications** and grant permission in the browser prompt.
3. Click **Subscribe this browser** to register for push notifications.

## Channels

| Channel | Behavior |
|---------|----------|
| **push** | Background push notification delivered by the browser, even when the tab is closed. Requires a push subscription. |
| **telegram** | Message sent to your Telegram chat. Configure bot token and chat ID in Settings → Integrations. |
| **os** | In-tab OS notification using the Web Notification API. Requires browser permission. |

Enable or disable each channel per event in the **Event toggles** section.

## Rules

The two event toggles cover fixed triggers. **Rules** are open-ended: each one watches a single field of every live hook event and notifies you when it matches.

A rule is a `{field, operator, pattern}` triple plus the channels to notify on:

| Part | Example |
|------|---------|
| field | `tool.input` |
| operator | `contains` |
| pattern | `.env` |
| channels | push + os |

Rules live in **Settings → Notifications → Rules**. Start from a suggested rule (**Add**) or build your own (**Add custom rule**).

### Suggested rules

| Rule | What it catches |
|------|-----------------|
| **Secret file accessed** | Any tool call whose path or command contains `.env`. The highest-value alert here: it tells you the moment a session reads credentials. |
| **Running with permissions bypassed** | A session in `bypassPermissions` mode — the state where nothing else asks you first. |
| **Tool call failed** | Any tool returning an error or non-zero exit code. |
| **Destructive shell command** | `rm -rf`. |
| **Force push** | `git push --force`. |
| **Tool call took over a minute** | Long builds and test runs. Ships disabled. |

### Fields

| Field | Set on | Notes |
|-------|--------|-------|
| `any` | all | Every text field concatenated — the catch-all. |
| `event` | all | `PreToolUse`, `PostToolUse`, `Stop`, … |
| `project` / `cwd` | all | Project slug and working directory. |
| `permissionMode` | all | `default`, `acceptEdits`, `plan`, `bypassPermissions`. |
| `tool.name` | tool events | `Bash`, `Edit`, `Write`, `Read`, `Task`, … |
| `tool.input` | tool events | Command text, file path, patch body. Where `.env` access shows up. |
| `tool.response` | `PostToolUse` | Result text, including error messages. |
| `tool.failed` | `PostToolUse` | `true` / `false` — always set on `PostToolUse`, so `equals false` matches successful calls. |
| `tool.durationMs` | `PostToolUse` | Numeric — use **is greater than**. |
| `prompt` | `UserPromptSubmit` | Text you submitted. |
| `message` | `Notification`, `SubagentStop` | Claude Code's own notification text. |
| `model` | `SessionStart` | |
| `agentType` | `SubagentStop` | |

A rule whose field is absent from an event never fires — so a `prompt` rule is silently skipped on a tool call rather than matching an empty string.

The **os** channel is delivered by the dashboard: a match is held server-side until a Minder tab next polls, then raised as a toast and a browser notification. It needs a tab open (any page) and browser notification permission granted. `push` and `telegram` are sent by the server and do not.

### Operators

`contains` and `equals` are **case-insensitive** — every realistic pattern (`.env`, `Bash`, `bypassPermissions`) is a human-typed literal where case sensitivity is a footgun. `matches regex` is also case-insensitive. `is greater than` / `is less than` compare numerically.

### Why some regexes are rejected

Rules run inline on the request a Claude Code session is blocked on, and JavaScript's regex engine backtracks and **cannot be interrupted** — there is no timeout to fall back on. A pattern like `(a+)+$` against a few thousand characters does not finish in the lifetime of the process, so it would not be a slow rule, it would be a frozen editor.

Two shapes are therefore refused:

| Shape | Example | Why |
|---|---|---|
| A quantifier applied to a group that itself quantifies or alternates | `(a+)+`, `(a\|b)*`, `([a-z]+)*` | Exponential — the engine can split the same input exponentially many ways. |
| Two adjacent unbounded quantifiers whose atoms can match the same character | `.*.*`, `\w+\w+`, `\w+\d+` | Polynomial in the field length. |

The second rule compares **character sets, not spelling**. `\w+\d+` looks like two different atoms but every digit is also a word character, so a run of digits can still be split between them in quadratically many ways — measured at ~22 seconds on a 4 000-character field. Conversely, adjacent quantifiers over genuinely *disjoint* atoms are fine and accepted: `a*b+`, `\w+\s*`, `[a-z]+[0-9]*`, `\W+\w+`, `\d+\.\d+`.

The check is deliberately **strict** where it cannot decide, so it also refuses some patterns that are in fact safe — `(foo|bar)+` is fine, because the alternatives cannot overlap, but no cheap check can tell. Erring strict is the cheaper mistake: a rejected pattern costs you one confusing rule, while an accepted bad one stalls your session.

**The workaround is almost always to lift the quantifier off the group**: `(foo|bar)+` → `(foo|bar)` or `foo|bar`.

Saving a rejected pattern gives you an **error explaining why**, so you can fix it. (A pattern hand-written straight into `.minder.json`, bypassing that check, is caught again at match time — there it simply never fires.)

### Noise control

Each rule has a **cooldown** (default 60s): the minimum gap between deliveries for that rule *in that project*. A failing test loop trips a `tool.failed` rule on every retry; the cooldown collapses that into one ping. Set it to `0` to disable throttling.

This is separate from the 5-minute duplicate-payload window, which suppresses *identical* notifications. Cooldown suppresses *different* ones from the same rule.

### Requirements and limits

- Rules see only what the hook receiver receives, so they need the **Live activity (hook server)** flag on and hooks installed (**Settings → Live activity → Install hooks**).
- The **Notification rules** feature flag is on by default, but nothing fires until you add a rule.
- Up to 50 rules; patterns up to 200 characters.
- Regex patterns whose worst-case cost is superlinear are rejected — see [Why some regexes are rejected](#why-some-regexes-are-rejected) above.
- Token-usage thresholds are **not** available as a rule field: hook events carry no token counts. That needs a polling evaluator over the usage index and is not built yet.

## Managing subscriptions

The subscriptions list shows every browser that has subscribed. Click **Revoke** to remove a specific device. Use **Send test push** to verify delivery at any time — test pushes bypass the 5-minute dedup window.

## Known limitations

- Push notifications require the browser to be open (background tab is fine). Fully closed browsers cannot receive pushes.
- On iOS Safari, Web Push is supported from iOS 16.4+ with the site added to Home Screen.
