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
/** Bounds the damage of any input the fingerprint does not cover; a forced rescan clears the cache outright. */
export const MAX_AGE_MS = 4 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const FLUSH_DELAY_MS = 1000;
/** Directory entries visited while fingerprinting; a tree bigger than this is not cached. */
export const MAX_WALK_ENTRIES = 25_000;

/**
 * Exactly what the CLI ignores by default (`DEFAULT_IGNORES`, gitignore semantics, so at any
 * depth), plus its own cache directory. Nothing else may be skipped: the CLI globs `**` and
 * would lint a `CLAUDE.md` under `.next/` or `target/`, so a change there has to miss.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".claudelint-cache"]);
/** Everything under these is fingerprinted, whatever it is called. */
const CONFIG_DIRS = new Set([
  ".claude", ".claude-plugin", ".claudelint", "skills", "agents", "commands", "hooks",
  "rules", "output-styles",
]);
/** Fingerprinted wherever they appear (the CLI globs `**` for several of these). */
const CONFIG_FILES = new Set([
  "CLAUDE.md", "CLAUDE.local.md", ".mcp.json", "plugin.json", "marketplace.json",
  "settings.json", "settings.local.json", "lsp.json", ".lsp.json", ".claudelintrc.json", ".claudelintignore", ".gitignore",
  "package.json", "pnpm-workspace.yaml",
]);
/** Looked up in the project AND every ancestor (the CLI walks up to find its config). */
const ANCESTOR_FILES = [".claudelintrc.json", ".claudelintignore", ".gitignore", "package.json", "pnpm-workspace.yaml"];

/** A cached report is trusted only if it has the shape `reportToFindings` reads; anything else is a miss. */
function isCliReport(r: unknown): r is CachedCliReport {
  const optString = (x: unknown) => x === undefined || typeof x === "string";
  // Every field `reportToFindings`/`toFinding` reads must have its expected type; a wrong
  // `severity` would otherwise be silently served as a warning.
  const message = (x: unknown) => {
    if (x === null || typeof x !== "object") return false;
    const m = x as Record<string, unknown>;
    return (
      typeof m.message === "string" &&
      (m.severity === "error" || m.severity === "warning" || m.severity === "info") &&
      optString(m.file) && optString(m.ruleId) && optString(m.explanation) && optString(m.howToFix)
    );
  };
  const messages = (m: unknown) => m === undefined || (Array.isArray(m) && m.every(message));
  const validators = (r as { validators?: unknown } | null)?.validators;
  return (
    Array.isArray(validators) &&
    validators.every(
      (v) =>
        v !== null &&
        typeof v === "object" &&
        typeof (v as { name?: unknown }).name === "string" &&
        messages((v as { errors?: unknown }).errors) &&
        messages((v as { warnings?: unknown }).warnings),
    )
  );
}

const g = globalThis as unknown as { __minderLintCache?: CacheState; __minderLintEpoch?: number };

export function lintCacheEnabled(): boolean {
  return process.env.MINDER_LINT_CACHE !== "0";
}

function stateDir(): string {
  return process.env.MINDER_STATE_DIR || path.join(os.homedir(), ".minder");
}

function cacheFilePath(): string {
  return path.join(stateDir(), "lint-cache.json");
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

/** A file above this makes the project uncacheable rather than being compared by metadata. */
const MAX_HASH_BYTES = 2 * 1024 * 1024;
/** `extends` files followed per project; more than this is not worth tracking. */
const MAX_EXTENDS = 20;
/** Concurrent filesystem calls while fingerprinting one project (scans fingerprint ten at a time). */
const IO_CONCURRENCY = 8;
/** `@import` / link targets tracked per project, and imported files read; more is not worth tracking. */
const MAX_REFS = 2000;
const MAX_IMPORTED_FILES = 200;
/** What the CLI's `fileExists` calls "does not exist": a failed `stat` of any kind. These we can reproduce. */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EINVAL", "ENAMETOOLONG", "ELOOP", "ERR_INVALID_ARG_VALUE"]);

// Both mirror claude-code-lint (`extractImportsWithLineNumbers` / `isImportPath`, and
// `skill-referenced-file-not-found`'s link pattern), minus its code-fence handling. tests/
// lintFingerprintConformance.test.ts runs the real CLI under an fs tracer and fails if it
// ever touches a path these miss.
const IMPORT_RE = /(?:^|\s)@(\S+)/g;
const isImportPath = (p: string): boolean => p.includes("/") || /\.\w{1,5}$/.test(p);
const SKILL_LINK_RE = /\[([^\]]+)\]\((?!https?:\/\/|#|\/|mailto:)(?:\.\/)?([^)]+)\)/g;

/**
 * Whether a settings file defines `apiKeyHelper`, the command the CLI then goes on to check. Decided
 * on the PARSED keys: `"apiKeyHelper"` is the same key to the CLI but not a substring match.
 * A file that does not parse falls back to a byte search that also treats any escape as a hit.
 */
function declaresApiKeyHelper(buf: Buffer): boolean {
  let cfg: unknown;
  try {
    cfg = JSON.parse(buf.toString("utf-8"));
  } catch {
    return buf.includes("apiKeyHelper") || buf.includes("\\u");
  }
  const has = (v: unknown, depth: number): boolean => {
    if (depth > 20 || v === null || typeof v !== "object") return depth > 20;
    if (Array.isArray(v)) return v.some((x) => has(x, depth + 1));
    return Object.entries(v).some(([k, x]) => k === "apiKeyHelper" || has(x, depth + 1));
  };
  return has(cfg, 0);
}

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

  let aborted = false;
  let active = 0;
  const waiters: Array<() => void> = [];
  /** Run leaf I/O under a small concurrency cap; stop scheduling as soon as the walk is abandoned. */
  const io = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (aborted) throw new UncacheableError();
    if (active >= IO_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
    if (aborted) {
      waiters.shift()?.();
      throw new UncacheableError();
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };

  /**
   * A file that vanished between `readdir` and read (ENOENT) is simply absent: the next scan sees
   * the change. Any other failure (permissions, a transient error) means an input could not be
   * read, so the fingerprint cannot be trusted to describe it.
   */
  const gone = (err: unknown): void => {
    if (err instanceof UncacheableError) throw err;
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw new UncacheableError();
  };

  const followed = new Set<string>();

  /**
   * Record a file by CONTENT, not size + mtime: an equal-length rewrite with a preserved or
   * same-tick timestamp must still miss. A config that `extends` another file is followed, so
   * editing the base invalidates too.
   */
  const note = async (abs: string, rel: string, parseExtends = false): Promise<void> => {
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await io(() => fs.stat(abs));
    } catch (err) {
      return gone(err);
    }
    // No config file is this big; one that is cannot be compared by content, so do not cache.
    if (st.size > MAX_HASH_BYTES) throw new UncacheableError();
    // The CLI also stats paths these declare (a plugin manifest's components, marketplace source
    // directories, `apiKeyHelper`). They are open-ended, so a project that has one is not cached.
    const name = path.basename(abs);
    if (name === "plugin.json" || name === "marketplace.json") throw new UncacheableError();
    let buf: Buffer;
    try {
      buf = await io(() => fs.readFile(abs));
    } catch (err) {
      return gone(err);
    }
    const base = path.basename(abs);
    if (/^settings(\.local)?\.json$/.test(base) && declaresApiKeyHelper(buf)) throw new UncacheableError();
    lines.push(`${rel}|${createHash("sha1").update(buf).digest("hex")}`);
    if (base.endsWith(".md")) await followReferences(abs, buf.toString("utf-8"));
    if (parseExtends || base === ".claudelintrc.json" || base === "package.json") {
      await followExtends(abs, buf.toString("utf-8"), parseExtends || base === ".claudelintrc.json");
    }
    if (base.endsWith(".json") && buf.includes('"hooks"')) await followHookScripts(abs, buf.toString("utf-8"));
  };

  const refs = new Set<string>();
  let importedFiles = 0;

  /** Whether the CLI would find nothing at this path: it treats every failed `stat` as "absent". */
  const absent = (err: unknown): boolean => {
    if (err instanceof UncacheableError) throw err;
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== undefined && ABSENT_CODES.has(code)) return true;
    throw new UncacheableError(); // permissions or a transient failure: the answer is unknown
  };

  /**
   * `claude-md-import-missing` (and the circular / depth / read-failed rules) `stat` and read the
   * file an `@import` names, resolved against the importing file's directory, wherever that is -
   * including outside the project - and follow the imports inside it. Record its existence and
   * content, and recurse. Matching is looser than the CLI's (code fences and inline code are not
   * skipped), so this tracks a superset.
   */
  const noteImport = async (target: string): Promise<void> => {
    const key = `imp:${target}`;
    if (refs.has(key)) return;
    refs.add(key);
    if (refs.size > MAX_REFS) throw new UncacheableError();
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await io(() => fs.stat(target));
    } catch (err) {
      absent(err);
      lines.push(`${key}|none`);
      return;
    }
    if (!st.isFile()) {
      lines.push(`${key}|other`);
      return;
    }
    if (st.size > MAX_HASH_BYTES || ++importedFiles > MAX_IMPORTED_FILES) throw new UncacheableError();
    let buf: Buffer;
    try {
      buf = await io(() => fs.readFile(target));
    } catch (err) {
      absent(err);
      lines.push(`${key}|none`);
      return;
    }
    lines.push(`${key}|${createHash("sha1").update(buf).digest("hex")}`);
    await followImports(target, buf.toString("utf-8"));
  };

  const followImports = async (abs: string, text: string): Promise<void> => {
    for (const m of text.matchAll(IMPORT_RE)) {
      // join, not resolve: the CLI's resolvePath() is resolve(join(dir, p)), so an absolute-looking
      // "@/x.md" stays under the importing file's directory (the conformance fixture pins this).
      if (isImportPath(m[1])) await noteImport(path.resolve(path.join(path.dirname(abs), m[1])));
    }
  };

  /** `skill-referenced-file-not-found` only `stat`s a SKILL.md link's target, so existence and type are enough. */
  const noteLink = async (target: string): Promise<void> => {
    const key = `lnk:${target}`;
    if (refs.has(key)) return;
    refs.add(key);
    if (refs.size > MAX_REFS) throw new UncacheableError();
    try {
      const st = await io(() => fs.stat(target));
      lines.push(`${key}|${st.isDirectory() ? "dir" : "file"}`);
    } catch (err) {
      absent(err);
      lines.push(`${key}|none`);
    }
  };

  /** The files a markdown config file points at: `@imports` anywhere, relative links in a SKILL.md. */
  const followReferences = async (abs: string, text: string): Promise<void> => {
    await followImports(abs, text);
    if (path.basename(abs) !== "SKILL.md") return;
    for (const m of text.matchAll(SKILL_LINK_RE)) await noteLink(path.resolve(path.join(path.dirname(abs), m[2])));
  };

  const scripts = new Set<string>();

  /**
   * `hooks-missing-script` checks that a hook command written as a bare `./x` or `../x` path
   * exists, relative to the project root (settings files) or to the config's directory (other
   * hook files). Record each such path's existence and content under both bases, so creating,
   * deleting or editing the script changes the fingerprint.
   */
  const followHookScripts = async (abs: string, text: string): Promise<void> => {
    let cfg: unknown;
    try {
      cfg = JSON.parse(text);
    } catch {
      return;
    }
    const hooks = (cfg as { hooks?: unknown } | null)?.hooks;
    if (!hooks || typeof hooks !== "object") return;
    for (const groups of Object.values(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const handlers = (group as { hooks?: unknown } | null)?.hooks;
        if (!Array.isArray(handlers)) continue;
        for (const h of handlers) {
          const cmd = (h as { command?: unknown } | null)?.command;
          if (typeof cmd !== "string" || !(cmd.startsWith("./") || cmd.startsWith("../")) || /\s/.test(cmd)) continue;
          for (const base of new Set([root, path.dirname(abs)])) {
            const target = path.resolve(base, cmd);
            if (scripts.has(target)) continue;
            scripts.add(target);
            try {
              const st = await fs.stat(target);
              if (st.isFile()) await note(target, `hook:${target}`);
              else lines.push(`hook:${target}|not-a-file`);
            } catch {
              lines.push(`hook:${target}|missing`);
            }
          }
        }
      }
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
    const entries = await io(() => fs.readdir(dir, { withFileTypes: true }));
    visited += entries.length;
    if (visited > maxEntries) {
      aborted = true;
      throw new UncacheableError();
    }
    const stats: Promise<void>[] = [];
    const subdirs: Array<() => Promise<void>> = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const childAbs = path.join(dir, e.name);
        // Custom rules are executable code that can import anything: not trackable, so not cached.
        if (e.name === ".claudelint" && (await fs.stat(path.join(childAbs, "rules")).then(() => true, () => false))) {
          throw new UncacheableError();
        }
        // A directory's existence inside a config scope is itself lintable (a deprecated empty
        // `commands/`, or `skill-deep-nesting` counting empty nested directories).
        if (inConfig || CONFIG_DIRS.has(e.name)) lines.push(`dir:${childRel}`);
        subdirs.push(() => walk(childAbs, childRel, inConfig || CONFIG_DIRS.has(e.name)));
      } else if (e.isSymbolicLink() && (inConfig || CONFIG_FILES.has(e.name) || CONFIG_DIRS.has(e.name))) {
        // The CLI may follow it; hashing the target safely (cycles, dangling) is not worth it.
        throw new UncacheableError();
      } else if (e.isFile() && (inConfig || CONFIG_FILES.has(e.name))) {
        stats.push(note(path.join(dir, e.name), childRel));
      }
    }
    await Promise.all([...stats, ...subdirs.map((next) => next())]);
  };

  try {
    await walk(root, "", false);
    // The directories above the project: the CLI's config search walks up through them.
    for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
      for (const name of ANCESTOR_FILES) await note(path.join(dir, name), `^${dir}|${name}`);
      if (path.dirname(dir) === dir) break;
    }
  } catch {
    aborted = true;
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
        if (v && typeof v.fingerprint === "string" && typeof v.savedAt === "number" && isCliReport(v.report)) {
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

/**
 * Bumped by `clearLintCache`. A caller reads it BEFORE it starts linting and passes it to
 * `putCachedLintReport`, so a run that was already in flight when the cache was cleared cannot
 * repopulate it afterwards with a result the clear was meant to discard.
 */
export function lintCacheEpoch(): number {
  return g.__minderLintEpoch ?? 0;
}

export async function putCachedLintReport(
  projectPath: string,
  fingerprint: string,
  report: CachedCliReport,
  now = Date.now(),
  epoch?: number,
): Promise<void> {
  if (epoch !== undefined && epoch !== lintCacheEpoch()) return;
  const state = getState();
  await state.loaded;
  if (epoch !== undefined && epoch !== lintCacheEpoch()) return;
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
  try {
    await fs.mkdir(path.dirname(state.file), { recursive: true });
    // The snapshot is taken INSIDE the lock, so queued flushes always write the current state:
    // an older flush that waited behind a clear cannot overwrite it with a stale copy.
    await withFileLock(state.file, () => {
      const newest = [...state.entries.entries()].sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ENTRIES);
      const body: CacheFile = { version: FILE_VERSION, entries: Object.fromEntries(newest) };
      return writeFileAtomic(state.file, JSON.stringify(body));
    });
  } catch {
    // best-effort
  }
}

/** Forget every cached report, in memory and on disk (a forced rescan: the user wants fresh lint). */
export async function clearLintCache(): Promise<void> {
  // Regardless of `MINDER_LINT_CACHE`: clearing is the escape hatch, and entries left on disk
  // would come back if caching were re-enabled within their lifetime.
  g.__minderLintEpoch = lintCacheEpoch() + 1;
  const state = getState();
  await state.loaded;
  state.entries.clear();
  await flushLintCache();
}

export function _resetLintCacheForTesting(): void {
  if (g.__minderLintCache?.timer) clearTimeout(g.__minderLintCache.timer);
  delete g.__minderLintCache;
}
