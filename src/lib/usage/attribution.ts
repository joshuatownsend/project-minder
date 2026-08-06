/**
 * Causal cost attribution for skills and MCP servers (A4).
 *
 * **Two signals that answer different questions, deliberately kept apart.**
 *
 *   - `tool_uses.mcp_server` / `tool_uses.skill_name` are *inferred* from the
 *     `mcp__server__tool` naming convention. They answer "was this call an MCP
 *     call, and to whom?" — a **call count**.
 *   - `turns.attribution_mcp_server` / `attribution_skill` are written by
 *     Claude Code itself. They answer "whose fault is this turn's token
 *     spend?" — a **cost attribution**.
 *
 * Conflating them is the bug this module exists to avoid, and the size of the
 * gap is easy to underestimate. Measured on the index (2026-08-05, period=all):
 *
 *     MCP servers   explicit $2,051.96   inferred $186.62    11.0x
 *     Skills        explicit $2,441.87   inferred   $6.54   373.4x
 *
 * The plan for this slice predicted inference would *over*-attribute. It does
 * the opposite, and the reason is structural: the turn that ISSUES a tool call
 * is usually tiny — often just a `tool_use` block — while the expensive turn is
 * the NEXT one, which pulls a large tool result into context and reasons over
 * it. Inference marks the cheap turn and misses the costly one it caused.
 *
 * Skills show it most starkly. `tool_uses.skill_name` fires only on an explicit
 * Skill invocation, so inference saw **8 turns / $6.54** — while `pr-resolve`
 * alone drove 6,528 turns costing $1,449 that inference cannot see at all.
 *
 * Both signals are kept. Counts keep using inference (`mcpParser.ts`); only
 * cost uses attribution. Nothing merges them into one number.
 */

/**
 * Which signal produced a figure. Carried on every attributed row so a chart
 * can never silently mix the two — they differ by an order of magnitude, so a
 * blended series would be meaningless in a way no axis label could rescue.
 */
export type AttributionMethod = "explicit" | "inferred";

/**
 * Fold an MCP server name to a key both signals agree on.
 *
 * The two sources spell the same server differently, and it is not cosmetic:
 * Claude Code's explicit field carries the real server id
 * (`plugin:playwright:playwright`, `claude.ai Vercel`), while the inferred name
 * is recovered from a *tool* name — and the tool-name encoding has already
 * replaced every character that isn't alphanumeric or a hyphen with `_`
 * (`mcp__plugin_playwright_playwright__browser_evaluate`).
 *
 * So the mapping runs one way only: encode the explicit name to reach the
 * inferred form. Reversing it is genuinely ambiguous — `claude_ai_Vercel`
 * could restore to `claude.ai Vercel` or `claude:ai:Vercel` and nothing in the
 * data distinguishes them.
 *
 * Validated on the corpus: 13 of 18 explicit names match an inferred name
 * exactly under this transform, with **zero collisions**. The five unmatched
 * ones simply never appeared as a recorded tool call. Without it the same
 * server lists twice — and the two spellings co-occur within 35 sessions, so
 * that is not a hypothetical.
 */
export function mcpServerKey(server: string): string {
  return server.replace(/[^A-Za-z0-9-]/g, "_");
}

/**
 * Prefer the explicit spelling for display; fall back to the inferred one.
 *
 * `plugin:playwright:playwright` is the name a user recognizes from their MCP
 * config. `plugin_playwright_playwright` is an artifact of how tool names are
 * encoded and appears nowhere a user has ever typed.
 */
export function mcpDisplayName(explicit: string | null | undefined, inferred: string): string {
  return explicit && explicit.trim() ? explicit : inferred;
}

/**
 * Rows below this share of attributed spend are folded into an "other" bucket
 * by the panels.
 *
 * Attribution has a long tail — 18 servers and 30+ skills on this corpus, most
 * of them fractions of a percent. Rendering every one turns a chart meant to
 * answer "what is expensive?" into a list that answers nothing, and the tail
 * items are exactly the ones whose individual numbers are least trustworthy.
 */
export const ATTRIBUTION_TAIL_SHARE = 0.01;

/**
 * Is this attribution value usable? Empty string and null both mean "not
 * attributed" and must not become a bucket named `""`.
 *
 * The equivalent gap shipped in A2 (`effort`) and was caught again in A3
 * (`entrypoint`): the TS side bucketed `""` while the SQL only `COALESCE`d
 * NULL, so the two backends disagreed. Every attribution query normalizes both.
 */
export function isAttributed(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
