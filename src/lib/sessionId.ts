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
 * **This predicate cannot separate the two spaces on its own, and must not be
 * asked to.** An earlier draft of #483 claimed `agent-` could not collide with
 * a real slug. That was wrong: `agent-cafe-deed` is a perfectly good slug whose
 * remainder is hex-and-dash, so admitting the prefix made such a slug read as
 * an id (Copilot, PR #484). Tightening the pattern — requiring a dash-free
 * suffix, or a length floor — only moves the boundary, and is another guess
 * about id content, which is the mistake this module exists to stop making.
 *
 * So `getSessionDetail` no longer relies on it alone: it asks the index whether
 * any session carries the string as a slug, and only falls back to this shape
 * test when none does. That is also why the long-documented `cafe-faded-deed`
 * edge case is gone rather than merely documented.
 *
 * What remains genuinely shape-only is `parseSubagentParentSessionId`, which
 * has no index to consult — it is reading a path segment. There the narrowness
 * is the whole point: the permissive traversal guard would let a stray
 * `subagents/` directory fabricate a parent id from its folder's name.
 */
const SESSION_ID_SHAPE_RE = /^(agent-)?[a-f0-9-]+$/i;

export function looksLikeSessionId(idOrSlug: string): boolean {
  return SESSION_ID_SHAPE_RE.test(idOrSlug);
}

/**
 * Does this id name a nested subagent transcript?
 *
 * An OPTIMIZATION guard, not a correctness gate, and the distinction is the
 * whole reason it is allowed to be a guess about content. `resolveSessionJsonl`
 * probes `<dir>/<parent>/subagents/<id>.jsonl` only after its flat pass misses,
 * and that walk is not cheap: measured on a reference tree, 80 project
 * directories holding 3,279 session subdirectories, of which **127 (3.9%)**
 * actually contain a `subagents/` directory. Running it on every miss put a
 * 1.4s readdir sweep and 3,279 `access` calls in front of every unresolvable
 * id — which is the ordinary 404 path for any bad session URL, and timed out a
 * test at 30s under parallel load.
 *
 * The asymmetry that makes the guess safe: skipping the walk for an id that is
 * NOT `agent-` prefixed costs nothing new, because such a file did not resolve
 * before this probe existed either. Running the walk for every miss is a broad
 * regression on the common path. So the guard may be wrong only in the
 * direction that restores the previous behaviour.
 *
 * Claude Code names these files `agent-*.jsonl`; 400 of 400 sampled from a real
 * index match. Ingest itself accepts any `.jsonl` under `subagents/`, so if
 * that ever stops holding, the symptom is a nested transcript that will not
 * open — not a wrong answer.
 */
export function isSubagentSessionId(sessionId: string): boolean {
  return /^agent-/i.test(sessionId);
}
