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
