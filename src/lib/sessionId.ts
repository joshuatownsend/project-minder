/**
 * Session-id predicates, in one place because copying them is what broke them.
 *
 * Two DIFFERENT questions have been asked with the same regex literal, in five
 * places, for as long as the session surface has existed:
 *
 *   1. "Is this string safe to interpolate into a filesystem path?"
 *   2. "Is this a session id, or is it a slug?"
 *
 * Both were spelled `/^[a-f0-9-]+$/i`, which answered (1) correctly by accident
 * and (2) correctly only while every session id was hex. Newer Claude Code
 * writes subagent transcripts to `<project>/<session>/subagents/agent-*.jsonl`,
 * and both backends derive the id from `path.basename(file, ".jsonl")` — so
 * those sessions are called `agent-<hex>`, and `g`/`n`/`t` are not in
 * `[a-f0-9-]`.
 *
 * The result was measured on a real index: **1,268 of 6,656 sessions (19%)**
 * listed by `loadSessionsListFromDb` — which filters only on `turn_count > 0` —
 * and rejected by every detail loader. Listed, and unopenable, on both
 * backends, so `MINDER_USE_DB=0` was not a workaround either (#483).
 *
 * The five sites agreed with each other the whole time. That is precisely why
 * it went unnoticed: agreement was maintained by copying a literal, so when the
 * id space widened they drifted in lockstep. Hence one module, imported — and
 * deliberately with NO imports of its own, so any server module can take it
 * without gaining a heavier graph.
 */

/**
 * Path-traversal guard: may this string be interpolated into a file path?
 *
 * The property actually being enforced is "contains no path syntax" — no `.`
 * (so no `..`), no `/`, no `\`, no drive colon, no NUL. It is deliberately NOT
 * an assertion about what an id looks like: encoding a guess about id CONTENT
 * is the mistake that produced #483, and this predicate should not need
 * revisiting the next time Claude Code introduces a prefix.
 */
const PATH_SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidSessionId(sessionId: string): boolean {
  return PATH_SAFE_ID_RE.test(sessionId);
}

/**
 * Discriminator: is this a session id, or a human-facing slug?
 *
 * This one must stay NARROW, and it is the reason `isValidSessionId` could not
 * simply be reused everywhere. `getSessionDetail` accepts either an id or a
 * slug and routes on this answer; widening it to the path-safe allowlist would
 * make every slug look like an id, and slug resolution would stop happening at
 * all.
 *
 * So it admits exactly the two id shapes Claude Code actually writes: a hex
 * session id, and the `agent-` prefixed subagent form.
 *
 * The pre-existing edge case is unchanged and still worth knowing: a slug made
 * only of hex letters (e.g. `cafe-faded-deed`) would be read as an id and miss
 * the loader. Claude Code's slug dictionary uses words with letters past `f`,
 * so it is not observed in practice. `agent-` cannot collide for the same
 * reason — a real slug would need every remaining character in `[a-f0-9-]`.
 */
const SESSION_ID_SHAPE_RE = /^(agent-)?[a-f0-9-]+$/i;

export function looksLikeSessionId(idOrSlug: string): boolean {
  return SESSION_ID_SHAPE_RE.test(idOrSlug);
}
