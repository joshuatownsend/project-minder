import { promises as fs } from "fs";
import path from "path";
import os from "os";

/**
 * Recursively resolves Claude Code's `@import <path>` directives in
 * CLAUDE.md / memory files so the audit and context-budget scanners can
 * count true on-load token cost rather than the raw index file's bytes.
 *
 * Mirrors Claude Code's behavior closely enough for budget estimation:
 *   - Recurses up to MAX_DEPTH levels (depth 0 = entry file)
 *   - Detects cycles via a visited Set keyed by canonical absolute path
 *   - Strips HTML block comments (`<!-- ... -->`) — Claude Code drops these
 *   - Expands `~` to the user's home directory in import specs
 *   - Skips directives that live inside fenced code blocks (```)
 *   - Treats unreadable imports as soft errors (recorded, content unchanged)
 */

export const MAX_DEPTH = 5;
const IMPORT_RE = /^[ \t]*@import[ \t]+(\S+)[ \t]*$/;
const FENCE_RE = /^[ \t]*(```|~~~)/;

export interface ExpandedImport {
  spec: string;
  resolved: string;
  depth: number;
  error?: string;
}

export interface ExpandResult {
  content: string;
  imports: ExpandedImport[];
  circular: string[];
  maxDepthHit: boolean;
}

interface ExpandState {
  imports: ExpandedImport[];
  circular: string[];
  maxDepthHit: { value: boolean };
}

function stripHtmlBlockComments(s: string): string {
  // Claude Code drops HTML block comments at load time; mirror that so
  // line counts in the audit + budget reflect what's actually loaded.
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

function expandTilde(spec: string): string {
  if (spec === "~") return os.homedir();
  if (spec.startsWith("~/") || spec.startsWith("~\\")) {
    return path.join(os.homedir(), spec.slice(2));
  }
  return spec;
}

function resolveImport(spec: string, parentDir: string): string {
  const expanded = expandTilde(spec);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(parentDir, expanded);
}

/**
 * Walk one file's lines, replacing `@import` directives with the
 * recursively-expanded content of the referenced file. Tracks fenced-code
 * state so a doc example like `@import ./foo.md` inside a ``` block is
 * left alone.
 *
 * Caller passes `raw` (already-read content) so the entry point can avoid
 * a redundant readFile when it's already done one (e.g. the audit).
 */
async function expandFromBuffer(
  filePath: string,
  raw: string,
  visited: Set<string>,
  depth: number,
  state: ExpandState
): Promise<string> {
  const canonical = path.resolve(filePath);
  visited.add(canonical);

  const stripped = stripHtmlBlockComments(raw);
  const lines = stripped.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  const parentDir = path.dirname(canonical);

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const m = line.match(IMPORT_RE);
    if (!m) {
      out.push(line);
      continue;
    }

    const spec = m[1];
    const resolved = resolveImport(spec, parentDir);
    const importDepth = depth + 1;

    if (visited.has(resolved)) {
      state.circular.push(resolved);
      continue;
    }
    if (importDepth > MAX_DEPTH) {
      state.maxDepthHit.value = true;
      out.push(line);
      continue;
    }

    try {
      const innerRaw = await fs.readFile(resolved, "utf-8");
      const inner = await expandFromBuffer(resolved, innerRaw, visited, importDepth, state);
      state.imports.push({ spec, resolved, depth: importDepth });
      out.push(inner);
    } catch (err) {
      state.imports.push({
        spec,
        resolved,
        depth: importDepth,
        error: err instanceof Error ? err.message : String(err),
      });
      out.push(line);
    }
  }

  return out.join("\n");
}

export async function expandImports(
  filePath: string,
  preread?: string
): Promise<ExpandResult> {
  const visited = new Set<string>();
  const state: ExpandState = {
    imports: [],
    circular: [],
    maxDepthHit: { value: false },
  };

  let raw: string;
  if (preread !== undefined) {
    raw = preread;
  } else {
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return {
        content: "",
        imports: [
          {
            spec: filePath,
            resolved: path.resolve(filePath),
            depth: 0,
            error: err instanceof Error ? err.message : String(err),
          },
        ],
        circular: [],
        maxDepthHit: false,
      };
    }
  }

  const content = await expandFromBuffer(filePath, raw, visited, 0, state);

  return {
    content,
    imports: state.imports,
    circular: state.circular,
    maxDepthHit: state.maxDepthHit.value,
  };
}
