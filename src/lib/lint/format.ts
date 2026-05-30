/**
 * Formatter wrapper around the library-owned `claudelint format`
 * (markdownlint + prettier, shellcheck optional). We deliberately do NOT
 * hand-roll a markdown/JSON normalizer: prettier preserves JSONC comments
 * and trailing commas that a naive `JSON.parse → JSON.stringify` would
 * silently destroy, and re-implementing two formatters is exactly the
 * duplication `runLibraryCli` already avoids for `check-all`. The library
 * owns the format contract; we own backup + change detection.
 *
 * Two modes:
 *   - `checkFormatting`  — runs `--fix-dry-run` (non-mutating) and parses
 *     which files WOULD be rewritten. Safe to call on every render.
 *   - `applyFormatting`  — snapshots each affected file via `recordPreWrite`
 *     BEFORE the mutating `--fix`, then re-reads to report what actually
 *     changed. Every rewrite is reversible from the config-history manifest.
 *
 * Apply must only ever run on an explicit user action (a button click) —
 * never on scan. It mutates the user's real project files.
 */

import { promises as fs } from "fs";
import path from "path";
import type { FormatApplyResult, FormatCheckResult, FormatFileResult } from "../types";
import { recordPreWrite, removeBackup } from "../configHistory";
import { spawnClaudelint } from "./library";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Parse the human-readable `format` output for the indented file list that
 * follows the `Files needing formatting:` header. The CLI has no JSON mode
 * for `format`, so we scan the text block: lines after the header that are
 * indented (start with whitespace) and non-empty, stopping at the first
 * blank or non-indented line (e.g. the trailing summary).
 */
function parseFilesNeedingFormat(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^Files needing formatting:/.test(l));
  if (headerIdx === -1) return [];

  const files: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || !/^\s/.test(line)) break;
    files.push(line.trim());
  }
  return files;
}

/**
 * Non-mutating check: which Claude files would the formatter rewrite?
 * Returns `filesNeedingFormat: []` when everything is clean, or an
 * `engineError` (with empty files) when the CLI could not run.
 */
export async function checkFormatting(
  projectPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FormatCheckResult> {
  const { stdout, error } = await spawnClaudelint("format", ["--fix-dry-run"], projectPath, timeoutMs);
  if (error) return { mode: "check", filesNeedingFormat: [], engineError: error };
  return { mode: "check", filesNeedingFormat: parseFilesNeedingFormat(stdout) };
}

/**
 * Apply formatting in place. Discovers the affected files via the same
 * dry-run discovery, snapshots each one to config history BEFORE the
 * mutating `--fix`, then re-reads to report per-file change + backup id.
 *
 * A file in the list whose bytes did not actually change has its (now
 * redundant) snapshot rolled back so the history manifest stays meaningful.
 */
export async function applyFormatting(
  projectPath: string,
  opts: { projectSlug?: string; timeoutMs?: number } = {},
): Promise<FormatApplyResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. Discover what will change (non-mutating) so we can snapshot first.
  const check = await checkFormatting(projectPath, timeoutMs);
  if (check.engineError) return { mode: "apply", formatted: [], engineError: check.engineError };
  if (check.filesNeedingFormat.length === 0) return { mode: "apply", formatted: [] };

  // 2. Snapshot each target + capture pre-format bytes for change detection.
  //    Snapshotting happens BEFORE any mutation so a fix is always reversible.
  //    Files that turn unreadable here are skipped (never enter `targets`), so
  //    `before` is always present for everything we go on to diff.
  const targets: Array<{ rel: string; abs: string; before: Buffer; backupId: string | null }> = [];
  for (const rel of check.filesNeedingFormat) {
    const abs = path.resolve(projectPath, rel);
    let before: Buffer;
    try {
      before = await fs.readFile(abs);
    } catch {
      // File listed but unreadable now — skip; the fix may still touch it,
      // but we can't snapshot/diff what we can't read.
      continue;
    }
    const backupId = await recordPreWrite(abs, {
      projectSlug: opts.projectSlug,
      label: "claudelint-format",
    });
    targets.push({ rel, abs, before, backupId });
  }

  // 3. Run the mutating fix. Note: unlike the single-file snapshot-then-write
  //    seam (configHistory.restore / hook toggles, which hold withFileLock
  //    across snapshot+write), the rewrite here is done by one external
  //    `--fix` process over the whole set — we can't hold N per-file locks
  //    across it, so a concurrent same-file restore could in principle
  //    interleave. Acceptable for this local, single-user, button-triggered
  //    action; the snapshots above still make every change revertable.
  const { error } = await spawnClaudelint("format", ["--fix"], projectPath, timeoutMs);
  if (error) return { mode: "apply", formatted: [], engineError: error };

  // 4. Re-read each target to report what actually changed; roll back the
  //    snapshot for any file the formatter left untouched.
  const formatted: FormatFileResult[] = [];
  for (const t of targets) {
    let after: Buffer | null = null;
    try {
      after = await fs.readFile(t.abs);
    } catch {
      after = null;
    }
    const changed = after !== null && !after.equals(t.before);
    if (!changed && t.backupId) {
      await removeBackup(t.backupId);
      formatted.push({ file: t.rel, backupId: null, changed: false });
    } else {
      formatted.push({ file: t.rel, backupId: t.backupId, changed });
    }
  }

  return { mode: "apply", formatted };
}
