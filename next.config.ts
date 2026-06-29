import type { NextConfig } from "next";

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
};

export default nextConfig;
