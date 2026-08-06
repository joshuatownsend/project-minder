# Cost Settings

Configure how project-minder displays costs and how it prices model usage.

## Display Currency

Choose the currency for all cost figures across the dashboard (Usage, Sessions, Stats, and project pages).

- Go to **Settings → Cost**
- Select a currency from the dropdown (30 currencies supported, powered by the Frankfurter API)
- The live exchange rate is shown below the selector
- Costs are stored in USD internally; the conversion is display-only

Exchange rates are cached for 24 hours in `~/.minder/exchange-rates.json`. If the Frankfurter API is unavailable, the last cached rate is used; if no cache exists, costs display in USD.

**Zero-decimal currencies** (JPY, KRW, IDR) show whole numbers with no fractional part.

## Pricing Rule Overrides

Override the per-model rates used to calculate session costs. Useful when Anthropic's published prices differ from what LiteLLM reports, or to model future pricing scenarios.

### Pattern syntax

Use `*` as a wildcard:

| Pattern | Matches |
|---|---|
| `claude-opus-4-7` | Exactly that model |
| `claude-opus-4*` | All Opus 4 variants |
| `*haiku*` | Any model with "haiku" in the name |
| `*` | All models |

Longer patterns take priority. If `claude-opus-4*` and `*` both match a model, the Opus rule wins.

### Rate fields

Each rule has four optional rate fields (USD per 1 million tokens). Leave a field blank to keep the LiteLLM default for that pricing dimension:

- **Input $/M** — input/prompt tokens
- **Output $/M** — output/completion tokens
- **Cache Read $/M** — tokens served from the prompt cache
- **Cache Write $/M** — tokens written into the prompt cache

### How cache writes are priced

Anthropic charges two different rates for writing to the prompt cache, depending
on the cache lifetime the request asked for:

| Cache TTL | Rate | Example (Claude Opus 5, $5/M base) |
| --- | --- | --- |
| 5 minutes (default) | 1.25× base input | $6.25 / M |
| 1 hour | 2× base input | $10 / M |

Minder reads the split from each turn's `usage.cache_creation` breakdown and
bills the two portions separately. **Claude Code writes its prompt cache at the
1-hour TTL**, so on a Claude Code transcript almost every cache-write token is
billed at the 2× rate. Transcripts old enough to predate that breakdown have no
split to read, and their cache writes are priced entirely at the 5-minute rate.

A **Cache Write $/M** override sets the 5-minute rate and scales the 1-hour rate
by the same proportion, preserving the 1.6× relationship between them.

### Long-context (>200K) pricing

A few Claude models charge a premium for prompts over 200,000 tokens. Where that
tier exists, the **whole request** — input *and* output — is billed at the higher
rate, not just the tokens past the boundary. Minder selects the tier per request,
so a session of many ordinary turns is never billed long-context just because its
turns add up to more than 200K.

**A 1M context window does not imply a long-context surcharge.** Anthropic's
pricing page states that Claude 4.6 and later include the full 1M window at
standard pricing, so Opus 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6 and Fable 5 are
billed flat no matter how long the prompt gets. The surcharge is real only for
the Sonnet 3.5–4.5 lineage, whose 1M window shipped as a priced beta at 2× input
and 1.5× output.

An **Input $/M** or **Output $/M** override scales the matching above-200K rate by
the same proportion, so the tier keeps its shape rather than leaving long prompts
at the provider's list price.

### Important notes

- Rule changes apply to **new session ingest immediately** — no restart required.
- **Previously indexed session costs are not retroactively recalculated.** If you need historical recost, delete `~/.minder/index.db` (all sessions will be re-indexed on next startup, which may take a few minutes).
- Click **Reset to defaults** to clear all overrides and return to LiteLLM pricing.

## Usage Quota (Claude Max)

Project Minder can display your Claude Max rolling-window utilization directly in the dashboard.

### How it works

When you authenticate Claude Code via OAuth (the default for Claude Max subscribers), Project Minder reads the access token from `~/.claude/.credentials.json` and makes a single minimal API call to `api.anthropic.com/v1/messages` (1-token Haiku response, ~$0.00001) to read the `anthropic-ratelimit-unified-*` response headers. This data is disk-cached for 5 minutes.

If you use an API key instead of OAuth, or your token has expired, the quota section will show "Not available" with the reason.

### Windows

Anthropic's Max tier exposes two rolling windows:

| Window | What it tracks |
|---|---|
| **5-hour** | The most recent 5-hour sliding window — the binding short-term limit |
| **7-day** | The rolling 7-day window — guards against sustained high usage |

Utilization is expressed as a percentage (0–100 %). The chart colours follow traffic-light semantics: green < 70 %, amber 70–90 %, red ≥ 90 %.

### Schedule mode

The schedule mode controls the active-time fraction used in the 7-day linear projection:

| Mode | Active fraction used in projection |
|---|---|
| **Weekdays (Mon–Fri)** | 5/7 ≈ 71 % of the window is expected active time |
| **Vibe coder** | 70 % — bursty work with frequent breaks |
| **24 × 7** | 100 % — always on |
| **Custom** | 100 % (no specific fraction defined yet) |

The projected utilization is a simple linear extrapolation based on elapsed window time and schedule mode. It helps answer "if I keep working at this rate, where will I land by reset time?"

### Quick status in Integrations

A compact status row in **Settings → Integrations** shows your current subscription type, overall status (● allowed / throttled), and the two window percentages at a glance, with a link to the full burndown chart in Cost.
