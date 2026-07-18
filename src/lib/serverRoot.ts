/**
 * Root directory of the running server installation.
 *
 * `MINDER_SERVER_ROOT` is set by the standalone package's generated
 * `server.js` wrapper (scripts/package-standalone.mjs) to the package's own
 * directory, so path resolution anchors correctly even when the packaged
 * server is launched by absolute path from some other cwd (PR #285 review).
 * Unset in dev/test, where `process.cwd()` is already the project root
 * (`next dev` / `next start` both run from it).
 *
 * The `turbopackIgnore` annotation keeps the dynamic `process.cwd()` read
 * out of Node File Tracing — without it the tracer can't statically bound
 * downstream `path.join` walks and falls back to tracing the whole project
 * into every route's standalone output. See the longer note in
 * src/lib/db/migrations.ts (resolveSchemaPath) and
 * https://nextjs.org/docs/messages/nft-unexpected-file-traced-in-nft-list
 */
export function resolveServerRoot(): string {
  return process.env.MINDER_SERVER_ROOT || /* turbopackIgnore: true */ process.cwd();
}

/**
 * Directory for WRITABLE user state that must survive app upgrades — currently
 * `.minder.json` (user prefs) and the cwd-derived pricing/stats caches.
 *
 * This is deliberately DISTINCT from {@link resolveServerRoot}: that anchors
 * READ-ONLY install assets (schema.sql, package.json) to the bundle, whereas a
 * packaged app bundle is either read-only or versioned (state written there
 * fails, or vanishes on upgrade). The packaged standalone server also
 * `process.chdir`s into its own directory, so `process.cwd()` in a packaged run
 * points INTO the bundle — writing `.minder.json` there is exactly the bug this
 * avoids.
 *
 * Precedence — no migration, just resolution order:
 *   1. `MINDER_STATE_DIR` — set by the tray for the sidecars it spawns, pointed
 *      at `~/.minder` (where logs + index.db already live) so state survives
 *      upgrades and read-only installs.
 *   2. `process.cwd()` — the existing behavior for a repo checkout (`pnpm dev`/
 *      `pnpm start`, the Phase A service), which finds the repo-root
 *      `.minder.json` exactly as before.
 */
export function resolveStateDir(): string {
  return process.env.MINDER_STATE_DIR || /* turbopackIgnore: true */ process.cwd();
}
