import { promises as fs } from "fs";
import path from "path";

interface PackageJsonResult {
  name?: string;
  framework?: string;
  frameworkVersion?: string;
  orm?: string;
  styling?: string;
  devPort?: number;
  dependencies: string[];
  monorepoType?: string;
}

const FRAMEWORK_DETECT: Record<string, string> = {
  next: "Next.js",
  vite: "Vite",
  express: "Express",
  fastify: "Fastify",
  "react-scripts": "CRA",
  nuxt: "Nuxt",
  astro: "Astro",
  remix: "Remix",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  gatsby: "Gatsby",
  hono: "Hono",
  elysia: "Elysia",
};

const ORM_DETECT: Record<string, string> = {
  drizzle: "Drizzle",
  "drizzle-orm": "Drizzle",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  typeorm: "TypeORM",
  sequelize: "Sequelize",
  knex: "Knex",
  mongoose: "Mongoose",
  kysely: "Kysely",
};

const STYLING_DETECT: Record<string, string> = {
  tailwindcss: "Tailwind",
  "@tailwindcss/postcss": "Tailwind",
  "styled-components": "Styled Components",
  "@emotion/react": "Emotion",
  "sass": "Sass",
  "@chakra-ui/react": "Chakra UI",
  "@mantine/core": "Mantine",
  "@mui/material": "MUI",
};

const MONOREPO_DETECT: Record<string, string> = {
  "turbo": "Turborepo",
  lerna: "Lerna",
  nx: "Nx",
};

function extractPort(scripts: Record<string, string>): number | undefined {
  const devScript = scripts.dev || scripts.start || "";
  // Match --port, -p, or PORT= patterns
  const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/);
  if (portMatch) return parseInt(portMatch[1], 10);
  const envMatch = devScript.match(/PORT=(\d+)/);
  if (envMatch) return parseInt(envMatch[1], 10);
  // Next.js default
  if (devScript.includes("next dev") && !portMatch) return 3000;
  // Vite default
  if (devScript.includes("vite") && !portMatch) return 5173;
  return undefined;
}

export async function scanPackageJson(
  projectPath: string
): Promise<PackageJsonResult> {
  const result: PackageJsonResult = { dependencies: [] };

  try {
    const raw = await fs.readFile(
      path.join(projectPath, "package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(raw);

    result.name = pkg.name;

    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    const depNames = Object.keys(allDeps);

    // Detect framework
    for (const [dep, name] of Object.entries(FRAMEWORK_DETECT)) {
      if (allDeps[dep]) {
        result.framework = name;
        result.frameworkVersion = allDeps[dep].replace(/[\^~>=<]/g, "");
        break;
      }
    }

    // Detect ORM
    for (const [dep, name] of Object.entries(ORM_DETECT)) {
      if (allDeps[dep]) {
        result.orm = name;
        break;
      }
    }

    // Detect styling
    for (const [dep, name] of Object.entries(STYLING_DETECT)) {
      if (allDeps[dep]) {
        result.styling = name;
        break;
      }
    }

    // Detect monorepo
    for (const [dep, name] of Object.entries(MONOREPO_DETECT)) {
      if (allDeps[dep]) {
        result.monorepoType = name;
        break;
      }
    }

    // Extract port from scripts
    if (pkg.scripts) {
      result.devPort = extractPort(pkg.scripts);
    }

    // Collect notable deps
    const notable = new Set([
      ...Object.keys(FRAMEWORK_DETECT),
      ...Object.keys(ORM_DETECT),
      ...Object.keys(STYLING_DETECT),
    ]);
    result.dependencies = depNames.filter((d) => notable.has(d));
  } catch {
    // No package.json or invalid
  }

  return result;
}
