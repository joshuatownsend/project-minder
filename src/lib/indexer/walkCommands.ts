import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "./parseFrontmatter";
import type { CommandEntry } from "../types";

type CommandSource = "user" | "plugin" | "project";

function makeCommandEntry(
  filePath: string,
  text: string,
  source: CommandSource,
  opts: {
    pluginName?: string;
    projectSlug?: string;
    category?: string;
    relPath: string;
    mtime: Date;
    ctime: Date;
    isSymlink?: boolean;
    realPath?: string;
  }
): CommandEntry {
  const { fm, body } = parseFrontmatter(text);

  const slug = path.basename(filePath, ".md");
  const rawName = fm.name;
  const name = typeof rawName === "string" && rawName ? rawName : slug;

  const rawTools = fm["allowed-tools"] ?? fm.allowedTools;
  let allowedTools: string[] | undefined;
  if (typeof rawTools === "string") {
    allowedTools = rawTools.split(",").map((t) => t.trim()).filter(Boolean);
  } else if (Array.isArray(rawTools)) {
    allowedTools = rawTools.map(String);
  }

  const prefix = opts.pluginName ?? opts.projectSlug ?? "user";
  const id = `command:${source}:${prefix}:${opts.relPath}`;

  return {
    id,
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
    allowedTools,
    argumentHint:
      typeof fm["argument-hint"] === "string" ? fm["argument-hint"] : undefined,
    isSymlink: opts.isSymlink,
    realPath: opts.realPath,
  };
}

async function readCommand(
  filePath: string,
  source: CommandSource,
  opts: {
    pluginName?: string;
    projectSlug?: string;
    category?: string;
    relPath: string;
    isSymlink?: boolean;
    realPath?: string;
  }
): Promise<CommandEntry | null> {
  try {
    const [text, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);
    return makeCommandEntry(filePath, text, source, {
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
  source: CommandSource,
  opts: { pluginName?: string; projectSlug?: string },
  depth = 0
): Promise<CommandEntry[]> {
  if (depth > 4) return [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: CommandEntry[] = [];
  const category = depth === 1 ? path.basename(dir) : undefined;

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const sub = await walkDir(fullPath, root, source, opts, depth + 1);
        results.push(...sub);
      } else if (entry.isSymbolicLink()) {
        let realTarget: string | undefined;
        try {
          realTarget = await fs.realpath(fullPath);
          const st = await fs.stat(realTarget);
          if (st.isDirectory()) {
            const sub = await walkDir(fullPath, root, source, opts, depth + 1);
            results.push(...sub);
          } else if (realTarget.endsWith(".md") && !realTarget.endsWith(".tmpl")) {
            const relPath = path
              .relative(root, fullPath)
              .replace(/\.md$/, "")
              .replace(/\\/g, "/");
            const cmd = await readCommand(fullPath, source, {
              ...opts,
              category,
              relPath,
              isSymlink: true,
              realPath: realTarget,
            });
            if (cmd) results.push(cmd);
          }
        } catch {
          // unresolvable — skip
        }
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        !entry.name.endsWith(".tmpl")
      ) {
        const relPath = path
          .relative(root, fullPath)
          .replace(/\.md$/, "")
          .replace(/\\/g, "/");
        const cmd = await readCommand(fullPath, source, { ...opts, category, relPath });
        if (cmd) results.push(cmd);
      }
    })
  );

  return results;
}

export async function walkUserCommands(): Promise<CommandEntry[]> {
  const root = path.join(os.homedir(), ".claude", "commands");
  return walkDir(root, root, "user", {});
}

export async function walkPluginCommands(
  installedPlugins: { pluginName: string; installPath: string }[]
): Promise<CommandEntry[]> {
  const all: CommandEntry[] = [];

  await Promise.all(
    installedPlugins.map(async ({ pluginName, installPath }) => {
      const commandsDir = path.join(installPath, "commands");
      try {
        await fs.access(commandsDir);
      } catch {
        return;
      }
      const entries = await walkDir(commandsDir, commandsDir, "plugin", { pluginName });
      all.push(...entries);
    })
  );

  return all;
}

export async function walkProjectCommands(
  projectPath: string,
  projectSlug: string
): Promise<CommandEntry[]> {
  const commandsDir = path.join(projectPath, ".claude", "commands");
  try {
    await fs.access(commandsDir);
  } catch {
    return [];
  }
  return walkDir(commandsDir, commandsDir, "project", { projectSlug });
}
