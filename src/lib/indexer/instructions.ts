import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "./parseFrontmatter";
import { readConfig } from "@/lib/config";
import type { InstructionEntry } from "./types";

// Harness-native instruction catalog (plan 007). Indexes the prose/instruction
// artifacts a coding harness keeps in its config home — Codex `rules/`,
// `AGENTS.md`, and `prompts/`, plus Gemini's global `GEMINI.md` context file —
// into a uniform `InstructionEntry` shape, gated by `enabledAdapters`.
// Deliberately separate from the agents/skills `CatalogResult`: these are a
// different artifact (no model/tools/layout), so they get their own type,
// loader, and `/api/instructions` route rather than rippling the agent/skill
// consumers.

const BODY_EXCERPT_CAP = 400;
const CACHE_TTL_MS = 5 * 60 * 1000;
// Bounded prefix read so a runaway file under CODEX_HOME can't be slurped whole
// on every cache miss — we only ever surface frontmatter + a 400-char excerpt.
// Mirrors the 64KB cap the Codex config reader uses (src/lib/config.ts).
const READ_CAP_BYTES = 65536;

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

/** Resolve the Gemini config home: `$GEMINI_HOME` if set, else `~/.gemini` —
 *  mirroring the Gemini session adapter's resolution (`src/lib/adapters/gemini.ts`)
 *  exactly, so both agree on an overridden home. */
function resolveGeminiHome(): string {
  const env = process.env.GEMINI_HOME;
  return typeof env === "string" && env.trim()
    ? path.resolve(env.trim())
    : path.join(os.homedir(), ".gemini");
}

function makeInstructionEntry(
  filePath: string,
  text: string,
  harness: Harness,
  category: string,
  mtime: Date,
  ctime: Date,
  fileBytes: number
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
    fileBytes,
  };
}

/** Read a single instruction file into an entry. Defensive: any read/stat error
 *  (missing file, not a regular file) yields null rather than throwing.
 *
 *  Only a bounded prefix (`READ_CAP_BYTES`) is read for frontmatter + excerpt;
 *  the true total size comes from `stat.size`, so `fileBytes` stays accurate
 *  even when the file is far larger than what we parse. `fs.stat` follows
 *  symlinks, so a symlinked instruction file resolves to its real target here. */
async function readInstruction(
  filePath: string,
  harness: Harness,
  category: string
): Promise<InstructionEntry | null> {
  let handle;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const toRead = Math.min(stat.size, READ_CAP_BYTES);
    let text = "";
    if (toRead > 0) {
      handle = await fs.open(filePath, "r");
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, 0);
      text = buf.toString("utf-8", 0, bytesRead);
    }
    return makeInstructionEntry(
      filePath,
      text,
      harness,
      category,
      stat.mtime,
      stat.ctime,
      stat.size
    );
  } catch {
    return null;
  } finally {
    await handle?.close();
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
      // Accept symlinks too: a dirent for a symlinked file reports
      // isSymbolicLink() (not isFile()), so stow/chezmoi-style symlinked Codex
      // instructions would otherwise be dropped. readInstruction() then stats
      // the target and re-checks it's a regular file, so a symlink-to-dir or a
      // broken link still gets filtered out there.
      (e) =>
        (e.isFile() || e.isSymbolicLink()) &&
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

/** Default Gemini context filename when settings don't override it. */
const GEMINI_DEFAULT_CONTEXT_FILE = "GEMINI.md";

/**
 * Resolve the Gemini context filename, honoring a `settings.json` override.
 * Gemini CLI lets you rename/extend the context file via the `context.fileName`
 * setting (newer, nested) or a legacy flat `contextFileName`; either may be a
 * single string or a list of accepted names. We read the file defensively (a
 * missing/unreadable/malformed settings.json falls back to `GEMINI.md`) and,
 * when a list is given, prefer an entry that equals the default `GEMINI.md`
 * (the global context file we surface) else take the first entry. Never throws.
 */
async function resolveGeminiContextFileName(home: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(home, "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as {
      context?: { fileName?: unknown };
      contextFileName?: unknown;
    };
    const configured =
      (settings.context && settings.context.fileName) ?? settings.contextFileName;

    if (typeof configured === "string" && configured.trim()) {
      return configured.trim();
    }
    if (Array.isArray(configured)) {
      const names = configured.filter(
        (n): n is string => typeof n === "string" && n.trim().length > 0
      );
      if (names.length > 0) {
        return names.find((n) => n === GEMINI_DEFAULT_CONTEXT_FILE) ?? names[0].trim();
      }
    }
  } catch {
    // Missing home, missing/unreadable settings.json, or invalid JSON — fall
    // through to the default. Indexing the global context file never depends
    // on settings.json existing.
  }
  return GEMINI_DEFAULT_CONTEXT_FILE;
}

/**
 * Walk Gemini instruction artifacts under the resolved Gemini home: the global
 * context file (`~/.gemini/GEMINI.md` by default, honoring a `context.fileName`
 * override in `settings.json`), tagged `harness: "gemini"`, `category:
 * "context"`. We deliberately index only the global context file in this cut —
 * `commands/*.toml` are a different artifact (TOML command defs, not prose).
 * Fully defensive — a missing home/file/settings just contributes nothing.
 */
export async function walkGeminiInstructions(): Promise<InstructionEntry[]> {
  const home = resolveGeminiHome();
  const fileName = await resolveGeminiContextFileName(home);
  const entry = await readInstruction(path.join(home, fileName), "gemini", "context");
  return entry ? [entry] : [];
}

// ── loader (config-gated + cached) ───────────────────────────────────────────

const g = globalThis as unknown as {
  __instructionsCache?: { key: string; data: InstructionEntry[]; cachedAt: number } | null;
};

export function invalidateInstructionsCache(): void {
  g.__instructionsCache = null;
}

/** Cache key over every input that changes the result: the enabled-adapter set
 *  (sorted, so order doesn't matter) and each harness home env override (Codex,
 *  Gemini). A change to any of these is a cache miss, so toggling an adapter in
 *  Settings — or pointing a harness at a different home — takes effect at once
 *  rather than after the TTL, without depending on the config route to remember
 *  to call invalidateInstructionsCache(). */
function cacheKey(enabled: string[]): string {
  return `${[...enabled].sort().join(",")}|${process.env.CODEX_HOME ?? ""}|${process.env.GEMINI_HOME ?? ""}`;
}

/**
 * Load the harness-instruction catalog, gated by `enabledAdapters`. Codex and
 * Gemini instructions appear only when their adapter is enabled; the default
 * (`["claude"]`) yields none — mirroring the opt-in model the session ingest
 * uses. Cached 5 minutes, like the agents/skills catalog.
 */
export async function loadInstructions(): Promise<InstructionEntry[]> {
  // readConfig() is itself cheaply cached (3s TTL), so consulting it on every
  // call is fine — and necessary to detect an adapter toggle. The result cache
  // is keyed by those inputs, so a key match within the TTL is a hit.
  const config = await readConfig();
  const enabled = config.enabledAdapters ?? ["claude"];
  const key = cacheKey(enabled);

  const slot = g.__instructionsCache;
  if (slot && slot.key === key && Date.now() - slot.cachedAt < CACHE_TTL_MS) {
    return slot.data;
  }

  const enabledSet = new Set(enabled);
  const groups: InstructionEntry[][] = [];
  if (enabledSet.has("codex")) groups.push(await walkCodexInstructions());
  if (enabledSet.has("gemini")) groups.push(await walkGeminiInstructions());

  const data = groups.flat();
  g.__instructionsCache = { key, data, cachedAt: Date.now() };
  return data;
}
