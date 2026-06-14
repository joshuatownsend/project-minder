import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "./parseFrontmatter";
import { readConfig } from "@/lib/config";
import type { InstructionEntry } from "./types";

// Harness-native instruction catalog (plan 007). Indexes the prose/instruction
// artifacts a coding harness keeps in its config home — Codex `rules/`,
// `AGENTS.md`, and `prompts/` today — into a uniform `InstructionEntry` shape,
// gated by `enabledAdapters`. Deliberately separate from the agents/skills
// `CatalogResult`: these are a different artifact (no model/tools/layout), so
// they get their own type, loader, and `/api/instructions` route rather than
// rippling the agent/skill consumers.

const BODY_EXCERPT_CAP = 400;
const CACHE_TTL_MS = 5 * 60 * 1000;

type Harness = InstructionEntry["harness"];

/** Resolve the Codex config home: `$CODEX_HOME` if set, else `~/.codex` — the
 *  same rule the Codex session adapter uses, so both agree on an overridden
 *  home. */
function resolveCodexHome(): string {
  const env = process.env.CODEX_HOME;
  return typeof env === "string" && env.trim()
    ? path.resolve(env.trim())
    : path.join(os.homedir(), ".codex");
}

function makeInstructionEntry(
  filePath: string,
  text: string,
  harness: Harness,
  category: string,
  mtime: Date,
  ctime: Date
): InstructionEntry {
  const { fm, body, warnings } = parseFrontmatter(text);
  const slug = path.basename(filePath, path.extname(filePath));
  const name = typeof fm.name === "string" && fm.name ? fm.name : slug;
  return {
    id: `instruction:${harness}:${category}:${slug}`,
    kind: "instruction",
    harness,
    slug,
    name,
    description: typeof fm.description === "string" ? fm.description : undefined,
    source: "user",
    category,
    filePath,
    bodyExcerpt: body.slice(0, BODY_EXCERPT_CAP),
    frontmatter: fm,
    mtime: mtime.toISOString(),
    ctime: ctime.toISOString(),
    provenance: { kind: "user-local" },
    parseWarnings: warnings.length > 0 ? warnings : undefined,
    fileBytes: Buffer.byteLength(text, "utf-8"),
  };
}

/** Read a single instruction file into an entry. Defensive: any read/stat error
 *  (missing file, not a regular file) yields null rather than throwing. */
async function readInstruction(
  filePath: string,
  harness: Harness,
  category: string
): Promise<InstructionEntry | null> {
  try {
    const [text, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);
    if (!stat.isFile()) return null;
    return makeInstructionEntry(filePath, text, harness, category, stat.mtime, stat.ctime);
  } catch {
    return null;
  }
}

/** Read instruction files (matching `exts`) directly under `dir`. Missing dir →
 *  []. Dotfiles are skipped; results are stable-sorted by filename. */
async function readInstructionDir(
  dir: string,
  harness: Harness,
  category: string,
  exts: string[]
): Promise<InstructionEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter(
      (e) =>
        e.isFile() &&
        !e.name.startsWith(".") &&
        exts.some((x) => e.name.toLowerCase().endsWith(x))
    )
    .map((e) => e.name)
    .sort();

  const out: InstructionEntry[] = [];
  for (const name of names) {
    const entry = await readInstruction(path.join(dir, name), harness, category);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Walk Codex instruction artifacts under the resolved Codex home:
 * `rules/*.{rules,md,txt}`, `prompts/*.{md,txt}`, and a top-level `AGENTS.md`.
 * Each is tagged `harness: "codex"` with a `category` of rules/prompts/agents.
 * Fully defensive — a missing home/dir/file just contributes nothing.
 */
export async function walkCodexInstructions(): Promise<InstructionEntry[]> {
  const home = resolveCodexHome();
  const [rules, prompts, agentsMd] = await Promise.all([
    readInstructionDir(path.join(home, "rules"), "codex", "rules", [".rules", ".md", ".txt"]),
    readInstructionDir(path.join(home, "prompts"), "codex", "prompts", [".md", ".txt"]),
    readInstruction(path.join(home, "AGENTS.md"), "codex", "agents").then((e) => (e ? [e] : [])),
  ]);
  return [...rules, ...prompts, ...agentsMd];
}

// ── loader (config-gated + cached) ───────────────────────────────────────────

const g = globalThis as unknown as {
  __instructionsCache?: { data: InstructionEntry[]; cachedAt: number } | null;
};

export function invalidateInstructionsCache(): void {
  g.__instructionsCache = null;
}

/**
 * Load the harness-instruction catalog, gated by `enabledAdapters`. Codex
 * instructions appear only when `"codex"` is enabled; the default
 * (`["claude"]`) yields none — mirroring the opt-in model the session ingest
 * uses. Cached 5 minutes, like the agents/skills catalog.
 *
 * Gemini instruction indexing is a deliberate follow-up (its instruction-file
 * model needs confirmation) — see `plans/007-harness-instructions-catalog.md`.
 */
export async function loadInstructions(): Promise<InstructionEntry[]> {
  const slot = g.__instructionsCache;
  if (slot && Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;

  const config = await readConfig();
  const enabled = new Set(config.enabledAdapters ?? ["claude"]);

  const groups: InstructionEntry[][] = [];
  if (enabled.has("codex")) groups.push(await walkCodexInstructions());

  const data = groups.flat();
  g.__instructionsCache = { data, cachedAt: Date.now() };
  return data;
}
