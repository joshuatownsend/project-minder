import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { withFileLock, writeFileAtomic } from "../atomicWrite";

// A persistent, per-project cache of the `claudelint check-all` result (#609 follow-up).
//
// Each lint is a ~1.2 s Node startup plus ~1 s of lint work, once per project per cold
// scan: 63 projects was 60-90 s of CPU at every boot and every 5-minute TTL expiry.
// Almost always nothing the CLI reads has changed, so the answer is the same. The cache is
// keyed on a fingerprint of everything the CLI could read, and a miss simply runs the CLI.
//
// What makes this safe is the direction of every error:
//   - the fingerprint is a SUPERSET of what the CLI reads (extra files only cost a spawn);
//   - anything unfingerprintable (too many entries, an unreadable dir) means "do not cache";
//   - a changed CLI version is part of the key;
//   - entries expire (`MAX_AGE_MS`), bounding the damage of a file the fingerprint missed.
// The raw validator output is stored, not Minder's mapped findings, so a change to the
// mapping in `library.ts` takes effect on the next scan without invalidating anything.

export interface CachedCliReport {
  validators: Array<{ name: string; errors?: unknown[]; warnings?: unknown[] }>;
}

interface CacheEntry {
  fingerprint: string;
  savedAt: number;
  report: CachedCliReport;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

interface CacheState {
  file: string;
  entries: Map<string, CacheEntry>;
  loaded: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const FILE_VERSION = 1;
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const FLUSH_DELAY_MS = 1000;
/** Directory entries visited while fingerprinting; a tree bigger than this is not cached. */
export const MAX_WALK_ENTRIES = 25_000;

/** Never contain lintable config; skipping them is what keeps the walk cheap. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", "target", "__pycache__",
  ".venv", "venv", "coverage", ".claudelint-cache",
]);
/** Everything under these is fingerprinted, whatever it is called. */
const CONFIG_DIRS = new Set([
  ".claude", ".claude-plugin", ".claudelint", "skills", "agents", "commands", "hooks",
  "rules", "output-styles",
]);
/** Fingerprinted wherever they appear (the CLI globs `**` for several of these). */
const CONFIG_FILES = new Set([
  "CLAUDE.md", "CLAUDE.local.md", ".mcp.json", "plugin.json", "marketplace.json",
  "settings.json", "settings.local.json", "lsp.json", ".claudelintrc.json", ".claudelintignore",
  "package.json", "pnpm-workspace.yaml",
]);
/** Looked up in the project AND every ancestor (the CLI walks up to find its config). */
const ANCESTOR_FILES = [".claudelintrc.json", ".claudelintignore", "package.json", "pnpm-workspace.yaml"];

const g = globalThis as unknown as { __minderLintCache?: CacheState };

export function lintCacheEnabled(): boolean {
  return process.env.MINDER_LINT_CACHE !== "0";
}

function stateDir(): string {
  return process.env.MINDER_STATE_DIR || path.join(os.homedir(), ".minder");
}

function cacheFilePath(): string {
  return path.join(stateDir(), "lint-cache.json");
}

/**
 * The directory handed to the CLI as `--cache-location`. Without it the CLI writes
 * `.claudelint-cache/` into every project it checks, which most projects do not gitignore (#610).
 */
export function lintCliCacheDir(projectPath: string): string {
  return path.join(stateDir(), "claudelint-cache", keyFor(projectPath).slice(0, 16));
}

function normalizeKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function keyFor(projectPath: string): string {
  return createHash("sha1").update(normalizeKey(projectPath)).digest("hex");
}

// ---- fingerprint ------------------------------------------------------------------------

/** Thrown to abandon a fingerprint that cannot be made complete; the caller then does not cache. */
class UncacheableError extends Error {}

/** Files above this are recorded by size + mtime instead of being read (none of the config is this big). */
const MAX_HASH_BYTES = 2 * 1024 * 1024;
/** `extends` files followed per project; more than this is not worth tracking. */
const MAX_EXTENDS = 20;

/**
 * Hash of every file the CLI could read for `projectPath`, plus `cliVersion`.
 * Returns null when the tree cannot be fingerprinted cheaply and completely.
 */
export async function lintFingerprint(
  projectPath: string,
  cliVersion: string,
  maxEntries = MAX_WALK_ENTRIES,
): Promise<string | null> {
  const root = path.resolve(projectPath);
  const lines: string[] = [`cli:${cliVersion}`];
  let visited = 0;

  const followed = new Set<string>();

  /**
   * Record a file by CONTENT, not size + mtime: an equal-length rewrite with a preserved or
   * same-tick timestamp must still miss. A config that `extends` another file is followed, so
   * editing the base invalidates too.
   */
  const note = async (abs: string, rel: string, parseExtends = false): Promise<void> => {
    let buf: Buffer;
    try {
      const st = await fs.stat(abs);
      if (st.size > MAX_HASH_BYTES) {
        lines.push(`${rel}|big|${st.size}|${Math.trunc(st.mtimeMs)}`);
        return;
      }
      buf = await fs.readFile(abs);
    } catch {
      return; // vanished between readdir and read: the next scan sees the change
    }
    lines.push(`${rel}|${createHash("sha1").update(buf).digest("hex")}`);
    const base = path.basename(abs);
    if (parseExtends || base === ".claudelintrc.json" || base === "package.json") {
      await followExtends(abs, buf.toString("utf-8"), parseExtends || base === ".claudelintrc.json");
    }
  };

  const followExtends = async (abs: string, text: string, wholeFileIsConfig: boolean): Promise<void> => {
    let cfg: unknown;
    try {
      cfg = JSON.parse(text);
    } catch {
      return; // unparseable: the CLI fails on it too, and its bytes are already in the hash
    }
    const section = wholeFileIsConfig ? cfg : (cfg as { claudelint?: unknown } | null)?.claudelint;
    const ext = (section as { extends?: unknown } | null | undefined)?.extends;
    for (const entry of ext === undefined ? [] : Array.isArray(ext) ? ext : [ext]) {
      if (typeof entry !== "string") throw new UncacheableError();
      if (entry.startsWith("claudelint:")) continue; // built-in preset: covered by the CLI version
      // A package or any other form we cannot resolve and hash: do not cache.
      if (!entry.startsWith("./") && !entry.startsWith("../") && !path.isAbsolute(entry)) throw new UncacheableError();
      const target = path.resolve(path.dirname(abs), entry);
      if (followed.has(target)) continue; // also stops an extends cycle
      if (followed.size >= MAX_EXTENDS) throw new UncacheableError();
      followed.add(target);
      await note(target, `ext:${target}`, true);
    }
  };

  const walk = async (dir: string, rel: string, inConfig: boolean): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    visited += entries.length;
    if (visited > maxEntries) throw new UncacheableError();
    const stats: Promise<void>[] = [];
    const subdirs: Array<() => Promise<void>> = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const childAbs = path.join(dir, e.name);
        subdirs.push(() => walk(childAbs, childRel, inConfig || CONFIG_DIRS.has(e.name)));
      } else if (e.isSymbolicLink() && (inConfig || CONFIG_FILES.has(e.name) || CONFIG_DIRS.has(e.name))) {
        // The CLI may follow it; hashing the target safely (cycles, dangling) is not worth it.
        throw new UncacheableError();
      } else if (e.isFile() && (inConfig || CONFIG_FILES.has(e.name))) {
        stats.push(note(path.join(dir, e.name), childRel));
      }
    }
    await Promise.all(stats);
    for (const next of subdirs) await next();
  };

  try {
    await walk(root, "", false);
    // The directories above the project: the CLI's config search walks up through them.
    for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
      for (const name of ANCESTOR_FILES) await note(path.join(dir, name), `^${dir}|${name}`);
      if (path.dirname(dir) === dir) break;
    }
  } catch {
    return null; // walk limit, or the project directory itself is unreadable
  }

  lines.sort();
  return createHash("sha1").update(lines.join("\n")).digest("hex");
}

// ---- store ------------------------------------------------------------------------------

function getState(): CacheState {
  const file = cacheFilePath();
  let state = g.__minderLintCache;
  if (state && state.file === file) return state;
  if (state?.timer) clearTimeout(state.timer);
  const entries = new Map<string, CacheEntry>();
  state = { file, entries, loaded: Promise.resolve(), timer: null };
  state.loaded = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as CacheFile;
      if (parsed?.version !== FILE_VERSION || typeof parsed.entries !== "object") return;
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (v && typeof v.fingerprint === "string" && typeof v.savedAt === "number" && v.report?.validators) {
          entries.set(k, v);
        }
      }
    } catch {
      // missing or corrupt: start empty, the next flush replaces it
    }
  })();
  g.__minderLintCache = state;
  return state;
}

/** The cached CLI report for this project, if its fingerprint still matches and it is fresh. */
export async function getCachedLintReport(
  projectPath: string,
  fingerprint: string,
  now = Date.now(),
): Promise<CachedCliReport | null> {
  const state = getState();
  await state.loaded;
  const entry = state.entries.get(keyFor(projectPath));
  if (!entry || entry.fingerprint !== fingerprint) return null;
  const age = now - entry.savedAt;
  if (age < 0 || age > MAX_AGE_MS) return null;
  return entry.report;
}

export async function putCachedLintReport(
  projectPath: string,
  fingerprint: string,
  report: CachedCliReport,
  now = Date.now(),
): Promise<void> {
  const state = getState();
  await state.loaded;
  state.entries.set(keyFor(projectPath), { fingerprint, savedAt: now, report });
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushLintCache();
  }, FLUSH_DELAY_MS);
  state.timer.unref?.();
}

/** Write the cache to disk now. Best-effort: a failure leaves the in-memory cache intact. */
export async function flushLintCache(): Promise<void> {
  const state = g.__minderLintCache;
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const newest = [...state.entries.entries()].sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ENTRIES);
  const body: CacheFile = { version: FILE_VERSION, entries: Object.fromEntries(newest) };
  try {
    await fs.mkdir(path.dirname(state.file), { recursive: true });
    await withFileLock(state.file, () => writeFileAtomic(state.file, JSON.stringify(body)));
  } catch {
    // best-effort
  }
}

export function _resetLintCacheForTesting(): void {
  if (g.__minderLintCache?.timer) clearTimeout(g.__minderLintCache.timer);
  delete g.__minderLintCache;
}
