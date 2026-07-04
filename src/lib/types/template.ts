// ─── Template Mode ──────────────────────────────────────────────────────────
// V1: single-unit copy across projects. V2 will add TemplateManifest +
// whole-template apply + new-project bootstrap.

export type UnitKind =
  | "agent"
  | "skill"
  | "command"
  | "hook"
  | "mcp"
  | "plugin"
  | "workflow"
  | "settingsKey";

export type ConflictPolicy = "skip" | "overwrite" | "merge" | "rename";

export type ApplySource =
  | { kind: "project"; slug: string }
  | { kind: "user" }
  | { kind: "library"; libraryId: string }
  /** Internal-only: direct path to a "virtual project root" — used by the
   *  template apply layer. Never accepted by the public API validator
   *  (would be a path-safety hole). */
  | { kind: "path"; path: string };

export type ApplyTarget =
  | { kind: "existing"; slug: string }
  | {
      kind: "new";
      /** Display name for logs / future scan results. */
      name: string;
      /** Path relative to the first configured devRoot. Validated against getDevRoots(). */
      relPath: string;
      /** Run `git init` after mkdir. Default true. */
      gitInit?: boolean;
    }
  /** Internal-only: direct path target — used by applyTemplate after it has
   *  bootstrapped a "new" target into a real directory. Never accepted by the
   *  public API validator. */
  | { kind: "path"; path: string };

export interface UnitRef {
  kind: UnitKind;
  key: string;
}

export interface ApplyRequest {
  unit: UnitRef;
  source: ApplySource;
  target: ApplyTarget;
  conflict: ConflictPolicy;
  dryRun?: boolean;
}

export type ApplyStatus =
  | "applied"
  | "skipped"
  | "merged"
  | "would-apply"
  | "error";

export interface ApplyResult {
  ok: boolean;
  status: ApplyStatus;
  changedFiles: string[];
  diffPreview?: string;
  bundle?: { rootName: string; files: string[]; totalBytes?: number };
  warnings?: string[];
  error?: { code: string; message: string };
}

// ─── Template Mode V2 — manifests + registry ─────────────────────────────────

/** A single unit selected into a template. The source content lives either in
 *  the live source project (for kind:"live" manifests) or in
 *  `<devRoot>/.minder/templates/<slug>/bundle/` (for kind:"snapshot" manifests).
 *  In either case the `key` is the same as Template Mode's per-kind unit key
 *  (see `unitKey.ts`). */
export interface TemplateUnitRef {
  kind: UnitKind;
  key: string;
  /** Display label, captured at promotion time. May drift in live mode. */
  name?: string;
  description?: string;
}

export interface TemplateUnitInventory {
  agents: TemplateUnitRef[];
  skills: TemplateUnitRef[];
  commands: TemplateUnitRef[];
  hooks: TemplateUnitRef[];
  mcp: TemplateUnitRef[];
  /** Plugin enable list. Keys are `<pluginName>@<marketplace>` (or just
   *  `<pluginName>` when there's no marketplace). Applying a plugin unit
   *  flips the target's `.claude/settings.json` enabledPlugins to true. */
  plugins: TemplateUnitRef[];
  /** GitHub Actions workflows. Keys are relative paths under
   *  `.github/workflows/` (e.g., "ci.yml"). Apply is file-replace only —
   *  workflows have no internal merge semantics. */
  workflows: TemplateUnitRef[];
  /** Generic `.claude/settings.json` keys. Keys are dotted JSON paths
   *  (e.g. "permissions.allow", "env.MY_VAR", "statusLine"). Apply uses a
   *  deep-merge with conflict-policy semantics; certain arrays
   *  (`permissions.allow` / `permissions.ask` / `permissions.deny`) use
   *  concat-and-dedupe. Hooks / MCP / plugin enables have dedicated unit
   *  kinds — picking those keys here would shadow the specialized paths,
   *  so the UI excludes them from the settingsKey picker. */
  settings: TemplateUnitRef[];
}

export type TemplateKind = "live" | "snapshot";

export interface TemplateManifest {
  schemaVersion: 1;
  slug: string;
  name: string;
  description?: string;
  kind: TemplateKind;
  /** When kind === "live": project slug whose .claude/ + .mcp.json this template tracks. */
  liveSourceSlug?: string;
  createdAt: string;
  updatedAt: string;
  units: TemplateUnitInventory;
}

/** A request to apply an entire template. */
export interface ApplyTemplateRequest {
  templateSlug: string;
  target: ApplyTarget;
  /** Default conflict policy applied to every unit unless `perUnitConflict` overrides. */
  conflictDefault: ConflictPolicy;
  /** Override the policy for specific units. Key shape: `<kind>:<unit-key>`. */
  perUnitConflict?: Record<string, ConflictPolicy>;
  dryRun?: boolean;
}

export interface ApplyTemplateResult {
  ok: boolean;
  /** Per-unit outcomes in inventory order. */
  results: Array<{
    unit: TemplateUnitRef;
    result: ApplyResult;
  }>;
  /** Aggregate counters useful for the apply-modal summary. */
  summary: {
    applied: number;
    merged: number;
    skipped: number;
    errors: number;
    wouldApply: number;
  };
  /** Bootstrap details when `target.kind === "new"`. */
  bootstrap?: {
    createdPath: string;
    gitInitialized: boolean;
  };
  error?: { code: string; message: string };
}
