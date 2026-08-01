/**
 * Cross-harness config drift — types.
 *
 * The inversion of ai-devkit: that tool reconciles `CLAUDE.md` / `AGENTS.md` /
 * `.cursor/rules` / MCP config across harnesses by **writing** from one source
 * of truth. Minder never writes harness config — the filesystem is the source
 * of truth and the index is derived, and becoming a config writer would break
 * that invariant. So this detects and reports; the user reconciles.
 */

/** A coding harness Minder can inventory. Matches `enabledAdapters` ids. */
export type DriftHarness = "claude" | "codex" | "gemini";

/**
 * The comparable artifact classes.
 *
 * - `mcp`         — configured MCP servers
 * - `skill`       — user-scope skills
 * - `instruction` — root instruction file + `rules/` entries
 */
export type DriftKind = "mcp" | "skill" | "instruction";

export const DRIFT_KINDS: readonly DriftKind[] = ["mcp", "skill", "instruction"];

export const DRIFT_KIND_LABEL: Record<DriftKind, { one: string; many: string }> = {
  mcp: { one: "MCP server", many: "MCP servers" },
  skill: { one: "skill", many: "skills" },
  instruction: { one: "instruction file", many: "instruction files" },
};

/** One comparable item in a harness's inventory. */
export interface DriftItem {
  kind: DriftKind;
  /**
   * Normalized comparison key — what makes "the same thing" the same thing
   * across two harnesses. Lowercased, and for instructions deliberately
   * decoupled from the filename: `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`
   * are one artifact under three names, so all three key to `(root)`.
   * Matching on filename would report each as permanently missing from the
   * other two harnesses.
   */
  key: string;
  /** How this harness spells it, for display. */
  name: string;
  /**
   * Definition fingerprint, compared only between harnesses that both have
   * the item. For MCP this is the launch command + args (or the URL); a
   * mismatch means one side is stale, which is the one drift signal worth
   * reporting per-item rather than in aggregate. Undefined when the kind has
   * no cheap fingerprint (skills, instructions — comparing bodies would mean
   * reading every file on every scan).
   */
  signature?: string;
}

export interface HarnessInventory {
  harness: DriftHarness;
  displayName: string;
  /** False when the harness's config home doesn't exist on this machine. */
  present: boolean;
  /**
   * Artifact classes this harness can hold. A harness that has no concept of
   * a kind must not be reported as "missing" every item of it — that is a
   * property of the harness, not a divergence the user can act on.
   */
  supports: DriftKind[];
  items: DriftItem[];
  /** Resolved config home, for the fix text. */
  home: string;
}
