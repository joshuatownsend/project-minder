import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "./parseFrontmatter";
import { loadInstalledPlugins } from "./walkPlugins";
import type { AgentEntry, CatalogSource } from "./types";

function makeAgentEntry(
  filePath: string,
  text: string,
  source: CatalogSource,
  opts: {
    pluginName?: string;
    projectSlug?: string;
    category?: string;
    relPath?: string;
    mtime: Date;
    ctime: Date;
  }
): AgentEntry {
  const { fm, body } = parseFrontmatter(text);

  const rawName = fm.name;
  const slug = path.basename(filePath, ".md");
  const name = typeof rawName === "string" && rawName ? rawName : slug;

  const rawTools = fm.tools ?? fm["allowed-tools"];
  let tools: string[] | undefined;
  if (typeof rawTools === "string") {
    tools = rawTools.split(",").map((t) => t.trim()).filter(Boolean);
  } else if (Array.isArray(rawTools)) {
    tools = rawTools.map(String);
  }

  const prefix = opts.pluginName ?? opts.projectSlug ?? "user";
  // Use relative path from the walk root so files with the same basename in
  // different subdirectories (e.g. category/README.md vs README.md) get unique IDs.
  const id = `${source}:${prefix}:${opts.relPath ?? slug}`;

  return {
    id,
    kind: "agent",
    slug,
    name,
    description: typeof fm.description === "string" ? fm.description : undefined,
    source,
    pluginName: opts.pluginName,
    projectSlug: opts.projectSlug,
    category: opts.category,
    filePath,
    bodyExcerpt: body.slice(0, 400),
    frontmatter: fm,
    mtime: opts.mtime.toISOString(),
    ctime: opts.ctime.toISOString(),
    model: typeof fm.model === "string" ? fm.model : undefined,
    tools,
    color: typeof fm.color === "string" ? fm.color : undefined,
    emoji: typeof fm.emoji === "string" ? fm.emoji : undefined,
  };
}

async function readAgent(
  filePath: string,
  source: CatalogSource,
  opts: { pluginName?: string; projectSlug?: string; category?: string; relPath?: string }
): Promise<AgentEntry | null> {
  try {
    const [text, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);
    return makeAgentEntry(filePath, text, source, {
      ...opts,
      mtime: stat.mtime,
      ctime: stat.ctime,
    });
  } catch {
    return null;
  }
}

async function walkDir(
  dir: string,
  root: string,
  source: CatalogSource,
  opts: { pluginName?: string; projectSlug?: string },
  depth = 0
): Promise<AgentEntry[]> {
  if (depth > 4) return [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: AgentEntry[] = [];
  const category = depth === 1 ? path.basename(dir) : undefined;

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const sub = await walkDir(fullPath, root, source, opts, depth + 1);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".tmpl")) {
        const relPath = path.relative(root, fullPath).replace(/\.md$/, "").replace(/\\/g, "/");
        const agent = await readAgent(fullPath, source, { ...opts, category, relPath });
        if (agent) results.push(agent);
      }
    })
  );

  return results;
}

export async function walkUserAgents(): Promise<AgentEntry[]> {
  const root = path.join(os.homedir(), ".claude", "agents");
  return walkDir(root, root, "user", {});
}

export async function walkPluginAgents(): Promise<AgentEntry[]> {
  const plugins = await loadInstalledPlugins();
  const all: AgentEntry[] = [];

  await Promise.all(
    plugins.map(async ({ pluginName, installPath }) => {
      const agentsDir = path.join(installPath, "agents");
      try {
        await fs.access(agentsDir);
      } catch {
        return;
      }
      const entries = await walkDir(agentsDir, agentsDir, "plugin", { pluginName });
      all.push(...entries);
    })
  );

  return all;
}

export async function walkProjectAgents(
  projectPath: string,
  projectSlug: string
): Promise<AgentEntry[]> {
  const agentsDir = path.join(projectPath, ".claude", "agents");
  try {
    await fs.access(agentsDir);
  } catch {
    return [];
  }
  return walkDir(agentsDir, agentsDir, "project", { projectSlug });
}
