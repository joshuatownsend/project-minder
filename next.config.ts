import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack/webpack rewrite barrel imports for these packages so each route
  // only ships the icons / helpers it actually uses. Drops a chunk of dead JS
  // off every shared bundle without touching application code.
  // See: https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns"],
  },
};

export default nextConfig;
