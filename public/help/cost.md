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

### Important notes

- Rule changes apply to **new session ingest immediately** — no restart required.
- **Previously indexed session costs are not retroactively recalculated.** If you need historical recost, delete `~/.minder/index.db` (all sessions will be re-indexed on next startup, which may take a few minutes).
- Click **Reset to defaults** to clear all overrides and return to LiteLLM pricing.
