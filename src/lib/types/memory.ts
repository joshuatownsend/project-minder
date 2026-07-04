export type MemoryType = "user" | "feedback" | "project" | "reference";

/**
 * Seed-generator candidate. A proposed memory file that hasn't been written
 * yet -- the user inspects + promotes (or skips) on /memory/seed.
 *
 * `targetProjectPath` is required at promote time so the writer knows which
 * memoryDirFor(...) to use. Per-project candidates carry it from the
 * generator; user-scope candidates have it as `null` until the user picks an
 * anchor project on the seed page.
 */
/** Per-row choice on /memory/seed. Drives the POST payload filter. */
export type SeedAction = "skip" | "create" | "overwrite";

export interface SeedCandidate {
  /** Basename with required typed prefix, e.g. "user_role.md". */
  fileName: string;
  type: MemoryType;
  /** "user" = needs an anchor project; "per-project" = auto-routed. */
  scope: "user" | "per-project";
  /** Pre-composed file content (frontmatter + body, ready to write). */
  body: string;
  /** First ~200 chars for inline preview, frontmatter stripped. */
  preview: string;
  /** Human-readable derivation trail, e.g. ["C:\\dev\\foo\\CLAUDE.md", "ProjectData(foo)"]. */
  provenance: string[];
  /** Per-project: set by generator. User-scope: null until anchor chosen. */
  targetProjectPath: string | null;
  /** Set when this candidate's filename already exists on disk. */
  conflict?: {
    existingPath: string;
    existingBody: string;
    /** True when the existing file carries the seed generator's marker. */
    existingIsSeeded: boolean;
  };
}

export interface MemoryFile {
  name: string;
  type?: MemoryType;
  description?: string;
  mtime: string;
  size: number;
}

export interface MemoryData {
  indexMd?: string;
  files: MemoryFile[];
}

export type MemoryScope = "user" | "project" | "auto";

export interface MemoryStaleness {
  ageOver30d: boolean;
  brokenImports: string[]; // unresolved @import specs (from expandImports)
  /**
   * Candidate file refs extracted from the memory body (e.g. `src/lib/foo.ts`,
   * `~/.claude/CLAUDE.md`) that don't resolve to a real file under either the
   * parent project's tree or any other scanned project. Distinct from
   * brokenImports — that's the structured `@import` directive; this is
   * free-prose path mentions.
   */
  brokenRefs: string[];
}

export interface MemoryFileEntry {
  /** base64url(absPath) — opaque, path-traversal safe identifier. */
  id: string;
  scope: MemoryScope;
  /** Project slug for `project` + `auto` scopes; undefined for `user`. */
  projectSlug?: string;
  /** Project name for display alongside slug; undefined for `user`. */
  projectName?: string;
  absPath: string;
  /** Display name — basename for project/auto, "User CLAUDE.md" for user. */
  displayName: string;
  mtimeMs: number;
  sizeBytes: number;
  /** First ~200 chars of body, frontmatter stripped. */
  preview: string;
  stale: MemoryStaleness;
  /**
   * For `auto` scope only: true if this file is referenced by the project's
   * MEMORY.md index. `undefined` for user/project scope (no index concept) and
   * for auto-scope rows when MEMORY.md is missing entirely.
   */
  indexed?: boolean;
  /**
   * Read telemetry derived from session JSONL replay. `undefined` when the
   * tracker hasn't been refreshed yet, or when this file has no recorded
   * reads. `readCount` is the lifetime count of `Read({file_path})` events
   * Claude Code emitted against this path; `lastReadAt` is the ISO 8601
   * timestamp of the most recent one.
   */
  usage?: {
    readCount: number;
    lastReadAt: string;
  };
}

/** Single bullet-link entry parsed out of a MEMORY.md index. */
export interface MemoryIndexEntry {
  title: string;
  /** Raw href as written in the markdown link (basename of a body file). */
  target: string;
  /** Free-text hook (em-dash side of `- [t](f.md) — hook`). */
  hook: string;
}

/**
 * Per-project rollup of MEMORY.md index state. One per project that has a
 * memory dir; consumed by the `/memory` summary banner and budget chips.
 */
export interface MemoryIndexSummary {
  projectSlug: string;
  projectName: string;
  /** True if MEMORY.md exists in this project's memory dir. */
  present: boolean;
  /** Line count of MEMORY.md (trailing blanks ignored). */
  lineCount: number;
  /** Number of valid bullet-link entries parsed out of the index. */
  entryCount: number;
  /** Body files in the dir not referenced from MEMORY.md. */
  orphans: string[];
  /** Index entries whose target file doesn't exist in the dir. */
  dangling: string[];
  /** Lowercased basenames the index actually points at (debug/audit). */
  linkedNames: string[];
}
