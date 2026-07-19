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
  serverExternalPackages: ["better-sqlite3", "web-push", "claude-code-lint"],
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
  output: "standalone",
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
  outputFileTracingExcludes: {
    "*": ["./dist/**", "./src-tauri/target/**"],
  },
};

export default nextConfig;
