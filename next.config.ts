import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Turbopack/webpack rewrite barrel imports for these packages so each route
  // only ships the icons / helpers it actually uses. Drops a chunk of dead JS
  // off every shared bundle without touching application code.
  // See: https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns"],
  },
  // Native addons and packages with dynamic requires must not be bundled.
  // better-sqlite3 uses a .node binary; web-push is pulled into the same
  // module graph via dispatcher → sender → connection. claude-code-lint
  // does `require.resolve("claude-code-lint/package.json")` to locate its
  // spawned CLI bin — if bundled, Turbopack rewrites that to a numeric
  // module ID and `path.dirname(<number>)` throws at runtime (prod only),
  // which would 500 every scan-backed route (/api/projects, /api/stats).
  // onnxruntime-node (transformers.js's local-embeddings backend) loads its
  // native binary via a runtime-constructed `bin/napi-v6/<platform>/<arch>/`
  // path — the same shape of problem as better-sqlite3 — so without this,
  // Next's static tracer copies the JS but misses libonnxruntime.so.1 next
  // to onnxruntime_binding.node. That didn't fail the Windows/macOS
  // installer builds (NSIS/DMG don't walk ELF dependencies at package time),
  // but broke the Linux AppImage build: linuxdeploy found the dangling
  // native binary and couldn't resolve its dependency (v1.7.0 release).
  serverExternalPackages: [
    "better-sqlite3",
    "web-push",
    "claude-code-lint",
    "@huggingface/transformers",
    "onnxruntime-node",
  ],
  // Move the Next.js dev indicator off the bottom-left, where it sits on top
  // of the Settings nav row in the new sidebar (was MEDIUM-7 in the
  // 2026-05-10 review). Production builds are unaffected.
  devIndicators: {
    position: "bottom-right",
  },
  // Emit a self-contained `.next/standalone/` server (a pruned copy of
  // node_modules containing only traced production dependencies, plus
  // server.js) so the app can be copied to another machine/directory and
  // run with just `node server.js` — no repo checkout or `pnpm install`
  // needed there. This is the sidecar payload for the planned Tauri tray
  // app (docs/superpowers/plans/2026-07-16-service-and-tray.md, task C0):
  // the tray shells out to this directory instead of managing a dev
  // server. `next dev` / `next start` from the repo are unaffected —
  // standalone output is only produced by `next build` and only consumed
  // by `scripts/package-standalone.mjs`.
  //
  // Exception — `next start` DOES care. It refuses to serve a standalone build
  // ("next start does not work with output: standalone configuration"), which
  // silently broke `capture:docs:prod` from #285 onward: the orchestrator's
  // server never came up, so screenshot captures quietly fell back to being
  // taken against `next dev` — the exact thing that orchestrator exists to
  // avoid. The capture path sets MINDER_BUILD_NO_STANDALONE=1 so its build
  // emits a normal server that `next start` can serve. Nothing else sets it;
  // packaging and CI still get standalone output.
  output: process.env.MINDER_BUILD_NO_STANDALONE === "1" ? undefined : "standalone",
  // Pin the file-tracing root to this project directory. Without this,
  // Next walks up from `next.config.ts` looking for the outermost
  // ancestor with a lockfile/package.json to infer a "workspace root" —
  // when this repo is checked out as a git worktree under
  // `.claude/worktrees/<id>/` (which nests inside the main checkout,
  // and both have their own `pnpm-lock.yaml`), that walk lands on the
  // main repo root instead of the worktree, and the standalone output
  // gets nested at `.next/standalone/.claude/worktrees/<id>/server.js`
  // instead of `.next/standalone/server.js`. Pinning here makes the
  // output path deterministic regardless of where the checkout lives.
  outputFileTracingRoot: projectRoot,
  // Never trace prior build artifacts into the standalone output. Without
  // this, the tracer sweeps dist/minder-server (the PREVIOUS package) into
  // .next/standalone, and package-standalone then copies that back out to
  // dist/minder-server — every build+package cycle nests another full copy
  // (observed: 16.8 GB / 37k files, two levels deep), and every later build
  // crawls the whole jungle during compile/trace collection (#312's
  // remaining slowness). The Tauri Rust target dir gets the same treatment.
  //
  // `dist/node` is the ~79 MB Node runtime that scripts/fetch-node-runtime.mjs
  // downloads for the installer. tauri.conf.json bundles it separately as its
  // own `node` resource, so a copy traced into the payload ships the entire
  // runtime TWICE in one installer. Today's release builds happen to escape
  // that: CI runs `pnpm build` (which traces) before `fetch-node-runtime`, so
  // on a fresh runner the directory doesn't exist yet. That makes the payload
  // correct by accident of step ordering rather than by construction —
  // reordering those steps, caching `dist/` between runs, or simply running
  // `pnpm release:local` twice reintroduces it silently. Excluding it here
  // makes the property hold regardless of what already exists on disk.
  //
  // These globs are compiled with picomatch `{ contains: true }` and the
  // leading `./` is stripped, so each pattern is a SUBSTRING match on any
  // path segment sequence. Keep them narrow: a broad `dist/**` would also
  // match `node_modules/next/dist/server/...` and strip the Next runtime out
  // of the standalone sidecar — which is also why this is `dist/node/` and not
  // `node/`. `dist/minder-server/`, `dist/node/` and `src-tauri/target/`
  // appear in no legitimate dependency path.
  // The entries below are a MITIGATION for #284, not a fix. NFT falls back to
  // sweeping the repo root into a route's trace instead of tracing only what
  // that route needs.
  //
  // Measured on 16.3.0 (`scripts/nft-census.mjs`, 213 manifests): the fallback
  // is PER-ROUTE and strictly bimodal — 124 routes trace 909 of `src/`'s 912
  // files, 89 trace zero. There are no intermediate values, so a route either
  // sweeps everything or nothing.
  //
  // Three things this rules out, each verified rather than assumed:
  //  - It is not one poisoned first-party module. `lib/adapters/codex.ts`
  //    contains the textbook unbounded `fs.readdir` walk and appears in the
  //    import closure of CLEAN routes.
  //  - It is not simply `better-sqlite3`/`bindings` (the native-addon resolver
  //    that walks parent directories). Those are present in all 122 poisoned
  //    routes that carry them AND in 20 clean ones — necessary-looking, not
  //    sufficient. No package perfectly separates the two groups.
  //  - It is not visible in the build output. 16.3.0 prints ZERO "unexpected
  //    file in NFT list" warnings while the sweep is completely intact, so
  //    warning count is not just noisy (as this comment previously said) but
  //    actively misleading. Measure the manifest.
  //
  // Do not re-run the `turbopackIgnore` experiment without first identifying a
  // target: it was measured to change nothing on 16.2.10, and on 16.3.0 — even
  // with upstream vercel/next.js#94361 shipped — the census above found no
  // call site to annotate. See #284 for the full data.
  //
  // These directories are provably never needed by the server at runtime, so
  // excluding them bounds the damage: 27,242 -> 1,369 entries, and traced repo
  // content 337 MB -> 15 MB. `src/` is deliberately NOT excluded — the worker
  // resolves `src/lib/db/schema.sql` at runtime and package-standalone.mjs has
  // a dedicated step to plant it, so a blanket `./src/**` would prune the DB
  // schema and break the index on a user's machine.
  //
  // `.git/` and `.claude/` earn their place on hygiene grounds rather than
  // size: both were being traced into .next/standalone on every build and were
  // stopped only by package-standalone's prune at the copy boundary (#284
  // shipped a real `.git` and `.env.local` once). Excluding them means they
  // never enter the pipeline at all, rather than being caught on the way out.
  //
  // Substring-match caveat (see the note above): `./tests/**` and `./docs/**`
  // also match e.g. `node_modules/<pkg>/tests/**`. Verified non-destructive by
  // measurement — the traced node_modules entry count is 243 both with and
  // without these excludes. Re-check that number if you add another entry.
  // `./.env*` and `.mcp.json` are here for the same reason as `.git/` and
  // `.claude/`, and are the most important entries in this list: both were
  // measured entering the trace of `/api/health` and `/api/projects` on
  // 16.3.0, i.e. local credentials were being handed to the packaging step
  // and stopped only by package-standalone's prune on the way out. Excluding
  // them keeps them out of the pipeline entirely. This costs nothing at
  // runtime — the packaged server takes its environment from the launcher,
  // never from a traced copy of the developer's env files.
  //
  // `.minder.json` is the third of the same kind and the least obvious: it is
  // gitignored (`.gitignore:33`) and present in any checkout where setup has
  // been run, holding the developer's scan roots, per-project statuses, port
  // overrides, notification prefs and feature flags. Shipping it does not
  // just leak configuration — it SEEDS every install with someone else's,
  // which is worse than shipping nothing. Excluding it is safe because the
  // runtime never reads a traced copy: `config.ts` resolves
  // `path.join(resolveStateDir(), ".minder.json")`, i.e. the user's own state
  // directory, and creates it there on first save.
  //
  // `.cache/` is deliberately NOT excluded here, and the reason is a worked
  // example of the substring caveat above. It is the same class of developer
  // state as the entries above — `claudeStatsCache.ts` writes
  // `.cache/claude-stats.json` keyed by ABSOLUTE transcript paths with
  // per-file token/tool/model/error counts — so excluding it looks obviously
  // right. But `.cache` is an ordinary directory name, and these globs cannot
  // be anchored: adding `./.cache/**` was measured to drop the traced
  // node_modules count from 372 to 368 on /api/health, because it also
  // matched `@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2/` —
  // the downloaded embedding model that backs semanticSearch, model weights
  // and all. Every other entry in this list names something no package
  // ships; this one does not, so it is enforced at the payload boundary
  // instead, where `FORBIDDEN_ROOT_RELATIVE` can anchor it to the payload
  // root. See scripts/payload-hygiene-rules.mjs.
  //
  // The pattern is the `.env` PREFIX, not the single file that happened to
  // be on disk when this was measured. `.gitignore` ignores both `.env` and
  // `.env*.local`, and the downstream payload-hygiene gate already fails on
  // any basename starting with `.env` (`scripts/payload-hygiene-rules.mjs`
  // `isForbiddenName`) — so `.env`, `.env.development.local` and
  // `.env.production.local` are every bit as secret-bearing as `.env.local`,
  // and a tracer-side boundary that covers only one of them still leans on
  // the prune this change exists to stop leaning on. Matching the hygiene
  // rule's set keeps the two ends of the pipeline agreed.
  //
  // `agentlytics-repo/` is a git-ignored reference checkout that happens to
  // sit inside the tracing root; 83 of its files (including a PNG and a
  // package-lock.json) were being traced into every poisoned route. Nothing
  // in the app imports it. It is listed rather than solved generically
  // because the tracer sweeps *everything* under the root that is not
  // excluded, so any ignored sibling directory has to be named.
  //
  // `.worktrees/` is the same class and is listed for the same reason,
  // pre-emptively: it is this repo's own supported git-worktree location
  // (`.gitignore:73-74`), so a checkout that actually has a worktree there
  // hands the tracer a second full copy of the source tree. On this machine
  // its three entries are empty, so it contributes nothing today — which is
  // exactly why it needs naming now rather than after a release build is cut
  // from a checkout where it isn't. `.claude/worktrees/` is already covered
  // by the `./.claude/**` entry above; this is the non-agent path.
  outputFileTracingExcludes: {
    "*": [
      "./dist/minder-server/**",
      "./dist/node/**",
      "./src-tauri/target/**",
      "./.git/**",
      "./.claude/**",
      "./.env*",
      "./.mcp.json",
      "./.minder.json",
      "./agentlytics-repo/**",
      "./.design-fetch/**",
      "./.codegraph/**",
      "./.playwright-mcp/**",
      "./.agents/**",
      "./.claudelint-cache/**",
      "./*.pem",
      "./.worktrees/**",
      "./tests/**",
      "./docs/**",
      "./site/**",
      "./screenshots/**",
      "./uiux-review/**",
      "./plans/**",
    ],
  },
};

export default nextConfig;
