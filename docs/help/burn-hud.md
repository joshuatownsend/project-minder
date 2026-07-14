# Burn HUD

The **burn HUD** in the top bar is a persistent rate-limit gauge. It always shows how hard you're burning against your Claude usage limits — the more-utilized of your two rolling windows, plus a projected **cap time** — so you can pace a long session without opening Settings. Click it for the full breakdown.

## What the chip shows

- **`BURN`** label, then the **utilization %** of whichever window is closer to its limit (your **5h** or **7d** rolling window), colour-coded: green < 70%, amber 70–90%, red ≥ 90%.
- The window that figure belongs to (`5h` or `7d`).
- When you're on track to hit 100% before that window resets, a **`cap ~3:40 PM`** hint — the wall-clock time you'd hit the wall *if the current rate holds*.

If neither window is projected to cap, the chip just shows the current percentage — no cap hint.

## The popover

Clicking opens a panel with all three windows:

- **5-hour** and **7-day** rolling windows, each with a utilization bar, its reset countdown, and either a projected cap time or a **`~N% projected`** end-of-window estimate.
- **Overage** — only shown once it's actually in play (some plans allow limited usage past the base limit).
- A footer noting your **schedule** and that the projection assumes the current rate continues, plus when the data was last fetched.

## How the projection works

The numbers come straight from the **authoritative rate-limit headers** Anthropic returns (`anthropic-ratelimit-unified-*`) — the same source the **burndown chart** in **Settings → Cost** uses. That utilization already reflects **all** of your Claude usage on the account (every client and machine), not just what Minder has indexed locally, so the gauge can't drift from the real limit.

- **Projected %** extrapolates the current average rate to the window's reset. The **7-day** projection is scaled by your **schedule** (set in Settings) — if you only code weekdays, Minder won't assume you'll keep burning over the weekend. The **5-hour** window is always treated as continuous.
- **Cap time** uses the raw linear rate (no schedule scaling): "at the pace so far, when do I hit 100%?" It's blank when a window would reset before you'd cap.

The data is cached with a 5-minute TTL and probes the cheapest model once per refresh, so the HUD costs effectively nothing.

## When it's hidden

The HUD self-hides whenever there's nothing useful to show:

- The **Burn HUD** feature flag (**Settings**, on by default) is off.
- Claude quota data isn't available — no valid OAuth credentials in `~/.claude/.credentials.json`, or the probe failed.
- The first fetch hasn't resolved yet (no empty flash on startup).

Turn it off any time via the **Burn HUD** flag in **Settings**.
