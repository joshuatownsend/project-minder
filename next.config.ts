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
  // module graph via dispatcher → sender → connection.
  serverExternalPackages: ["better-sqlite3", "web-push"],
};

export default nextConfig;
