import type { MemoryIndexEntry, MemoryIndexSummary } from "../types";

// MEMORY.md is Claude Code's always-loaded auto-memory index. The contract:
// bullet lines shaped like `- [Title](file.md) -- one-line hook` (em-dash or
// double-hyphen; both observed). Non-matching lines are skipped, not flagged,
// since MEMORY.md is freely human-edited and routinely mixes headings, plain
// bullets, and prose. Only matched lines participate in orphan/dangling joins.

const LINE_REGEX = /^-\s+\[(.+?)\]\(([^)]+?)\)\s+(?:—|--)\s+(.+)$/;

export function parseMemoryIndex(content: string): MemoryIndexEntry[] {
  if (!content) return [];
  const out: MemoryIndexEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const m = LINE_REGEX.exec(rawLine.trim());
    if (!m) continue;
    out.push({
      title: m[1].trim(),
      target: m[2].trim(),
      hook: m[3].trim(),
    });
  }
  return out;
}

export function countMemoryIndexLines(content: string): number {
  if (!content) return 0;
  const trimmed = content.replace(/[\r\n]+$/, "");
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).length;
}

interface JoinResult {
  linkedNames: Set<string>;
  orphans: string[];
  dangling: string[];
}

export function joinMemoryIndex(
  entries: MemoryIndexEntry[],
  bodyFilenames: string[],
): JoinResult {
  const linkedNames = new Set<string>();
  const dangling: string[] = [];
  const fileSet = new Set(bodyFilenames.map((n) => n.toLowerCase()));

  for (const e of entries) {
    const target = e.target;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue;
    if (target.startsWith("#")) continue;
    if (target.startsWith("/") || target.startsWith("\\")) continue;
    // Strip leading `./` (and `.\`) so `- [Foo](./foo.md)` matches `foo.md`
    // on disk. Markdown link conventions commonly use the explicit
    // current-dir prefix; without normalization those entries surface as
    // false dangling links while the real file is flagged as orphan.
    const stripped = target.replace(/^\.[/\\]+/, "");
    const cleaned = stripped.split("#")[0].split("?")[0].trim();
    if (!cleaned.toLowerCase().endsWith(".md")) continue;
    const lower = cleaned.toLowerCase();
    linkedNames.add(lower);
    if (!fileSet.has(lower)) dangling.push(cleaned);
  }

  const orphans: string[] = [];
  for (const f of bodyFilenames) {
    if (f.toLowerCase() === "memory.md") continue;
    if (!linkedNames.has(f.toLowerCase())) orphans.push(f);
  }

  return { linkedNames, orphans, dangling };
}

export function summarizeMemoryIndex(args: {
  projectSlug: string;
  projectName: string;
  indexContent: string | null;
  bodyFilenames: string[];
}): MemoryIndexSummary {
  const { projectSlug, projectName, indexContent, bodyFilenames } = args;
  if (indexContent === null) {
    return {
      projectSlug,
      projectName,
      present: false,
      lineCount: 0,
      entryCount: 0,
      orphans: bodyFilenames.filter((f) => f.toLowerCase() !== "memory.md"),
      dangling: [],
      linkedNames: [],
    };
  }
  const entries = parseMemoryIndex(indexContent);
  const { linkedNames, orphans, dangling } = joinMemoryIndex(entries, bodyFilenames);
  return {
    projectSlug,
    projectName,
    present: true,
    lineCount: countMemoryIndexLines(indexContent),
    entryCount: entries.length,
    orphans,
    dangling,
    linkedNames: Array.from(linkedNames),
  };
}
