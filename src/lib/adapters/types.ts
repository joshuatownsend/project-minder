import type { UsageTurn } from "@/lib/usage/types";
import type { SessionTurnsMeta } from "@/lib/usage/parser";

export interface SessionFile {
  source: string;
  filePath: string;
  projectDirName: string;
}

export interface SessionAdapter {
  id: string;
  displayName: string;
  discover(): Promise<SessionFile[]>;
  /**
   * Parse one transcript into turns.
   *
   * **An empty array is a verdict about the file's contents; a rejection is the
   * absence of one.** Implementations MUST let `EACCES` / `EBUSY` / `EIO` and
   * every other read failure propagate, and MUST return `[]` only for a file
   * that was read and holds nothing usable — empty, malformed, or missing the
   * metadata the harness needs.
   *
   * The distinction is load-bearing wherever the result is cached, which is
   * every caller. A verdict derived from the bytes stays valid as long as the
   * bytes do, which is exactly what an mtime+size cache key guarantees; a
   * failure to read says nothing about the bytes, and caching it makes a
   * transient condition permanent — restoring permissions touches ctime, not
   * mtime or size, so the entry is never revisited and the session stays hidden
   * until a restart.
   *
   * Both implementations used to swallow their own `readFile` error and return
   * `[]`, which produced exactly that on the session list (#495) and, unnoticed
   * for longer, on the usage sweep (#490). (#498.)
   */
  parseFile(file: SessionFile): Promise<UsageTurn[]>;
  /** Same contract as {@link SessionAdapter.parseFile} for read failures. */
  parseFileWithMeta?(file: SessionFile): Promise<{ turns: UsageTurn[]; meta: SessionTurnsMeta }>;
  /**
   * Read-only view of the harness's own config home (item 1). Optional — only
   * harnesses with a discoverable config surface implement it (Claude/Gemini
   * leave it undefined). MUST be defensive: a missing home, unparseable config,
   * or permission error returns a degraded `HarnessConfig` rather than throwing.
   * MUST redact secrets — implementations parse then redact the object before
   * returning (see `redactConfig`); raw secret-bearing text never escapes.
   */
  readConfig?(): Promise<HarnessConfig>;
}

/** A single rules/instructions file under the harness config home. */
export interface HarnessConfigRule {
  name: string;
  content: string;
  /** True when `content` was truncated to the per-file display cap. */
  truncated: boolean;
}

/** Presence flag for a notable subdir under the config home — surfaced without
 *  slurping its contents (some, like `archived_sessions`, are huge). */
export interface HarnessResource {
  name: string;
  present: boolean;
}

/**
 * Read-only snapshot of a harness's config home. `config` is the parsed,
 * **secret-redacted** main config object (e.g. Codex's `config.toml`); `null`
 * when absent or unparseable (`parseError` then explains). Auth/credential
 * files are never read.
 */
export interface HarnessConfig {
  harnessId: string;
  displayName: string;
  /** Resolved config home (e.g. `~/.codex` or `$CODEX_HOME`). */
  home: string;
  /** False when the config home doesn't exist on this machine. */
  present: boolean;
  /** Parsed + redacted main config object; null if absent/unparseable. */
  config: unknown | null;
  /** Set when the main config file exists but couldn't be parsed. */
  parseError?: string;
  /** Rules/instructions files (content included, capped). */
  rules: HarnessConfigRule[];
  /** Presence of notable subdirs (no content read). */
  resources: HarnessResource[];
}
