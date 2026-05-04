import { promises as fs } from "fs";
import path from "path";
import { expandImports } from "./expandImports";
import { walkMdTree } from "./mdTreeWalk";
import { formatKB } from "../utils";
import type {
  ClaudeMdAuditCode,
  ClaudeMdAuditFinding,
  ClaudeMdAuditInfo,
  AuditFindingSeverity,
} from "../types";

export type { ClaudeMdAuditCode, ClaudeMdAuditFinding, ClaudeMdAuditInfo, AuditFindingSeverity };

/**
 * 0–100 workspace health score for a project's CLAUDE.md ecosystem.
 *
 * Formula (TODO #118):
 *   - Long index: tiered penalty for project CLAUDE.md (post-@import-expand)
 *     length. There is **no hard truncation** — Claude Code reads the whole
 *     file. The penalty captures practitioner heuristics: rule adherence
 *     starts degrading past ~150 lines, the practical instruction-following
 *     budget is ~200–300, and ~500 lines is the upper bound where latency
 *     and "lost in the middle" effects become severe.
 *       >150 lines → -3 (P2)
 *       >300 lines → -8 (P1)
 *       >500 lines → -15 (P0)
 *   - File size: tiered penalty for the on-disk CLAUDE.md byte count.
 *     Claude Code itself surfaces a warning at 40 KB because the file is
 *     re-injected into context every turn.
 *       >40 KB → -10 (P1)
 *       >80 KB → -20 (P0)
 *   - Inline bloat:  sections (`#`-headed) with >5 non-empty content lines
 *                    → -3 to -15 (scaled by section count)
 *   - Missing topic files: index >50 lines and no sibling `.md` files → -10
 *   - Rules volume: total `.claude/rules/**.md` lines >2000 → -5 to -20
 *   - Reference tiering: rules files matching reference/guide/template/...
 *                        and >50 lines should be on-demand → -2 to -10
 *
 * Line/section counts use the @import-expanded, comment-stripped content
 * so the score reflects on-load cost, not the raw index byte count.
 * `long-index` and `file-size` are scoped to the **project** CLAUDE.md
 * (the user-scope `~/.claude/CLAUDE.md` is the same across every project
 * and shouldn't drag per-project scores down).
 */

const LONG_INDEX_LIGHT_LINES = 150;
const LONG_INDEX_HEAVY_LINES = 300;
const LONG_INDEX_SEVERE_LINES = 500;
const FILE_SIZE_WARN_BYTES = 40 * 1024;   // Claude Code's own warn threshold
const FILE_SIZE_SEVERE_BYTES = 80 * 1024; // 2× warn — severe per-turn cost
const SECTION_BLOAT_LINE_THRESHOLD = 5;
const RULES_VOLUME_LINE_THRESHOLD = 2000;
const ON_DEMAND_FILENAME_RE = /(reference|guide|template|example|sql|database|api|schema|migration)/i;

const LONG_INDEX_FIX =
  "Move detail to topic-scoped `.claude/rules/` files. Use `@import` only for content that must load every turn — reference the rest by name and let Claude open them on demand.";
const FILE_SIZE_FIX =
  "Split CLAUDE.md into a small high-signal index plus topic files in `.claude/rules/`. Avoid `@import`-ing large files since their content is inlined into every turn.";

const SEVERITY_ORDER: Record<AuditFindingSeverity, number> = { P0: 0, P1: 1, P2: 2 };

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function countNonEmpty(lines: string[]): number {
  let n = 0;
  for (const l of lines) if (l.trim() !== "") n += 1;
  return n;
}

function countBloatedSections(content: string): number {
  const lines = content.split(/\r?\n/);
  const sectionLines: string[][] = [];
  let buf: string[] | null = null;

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (buf) sectionLines.push(buf);
      buf = [];
    } else if (buf) {
      buf.push(line);
    }
  }
  if (buf) sectionLines.push(buf);

  let bloated = 0;
  for (const section of sectionLines) {
    if (countNonEmpty(section) > SECTION_BLOAT_LINE_THRESHOLD) bloated += 1;
  }
  return bloated;
}

function inlineBloatPenalty(bloated: number): number {
  if (bloated <= 0) return 0;
  if (bloated >= 5) return 15;
  return 3 + (bloated - 1) * 3;
}

function rulesVolumePenalty(totalLines: number): number {
  if (totalLines <= RULES_VOLUME_LINE_THRESHOLD) return 0;
  const excess = totalLines - RULES_VOLUME_LINE_THRESHOLD;
  if (excess >= 6000) return 20;
  if (excess >= 4000) return 15;
  if (excess >= 2000) return 10;
  return 5;
}

function tieringPenalty(matchingFiles: number): number {
  if (matchingFiles <= 0) return 0;
  if (matchingFiles >= 5) return 10;
  return 2 + (matchingFiles - 1) * 2;
}

async function hasSiblingMd(projectPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(projectPath);
    return entries.some(
      (e) => e.toLowerCase().endsWith(".md") && e.toLowerCase() !== "claude.md"
    );
  } catch {
    return false;
  }
}

export async function auditClaudeMd(
  projectPath: string,
  /** Pre-read CLAUDE.md content so the orchestrator can avoid a second
   *  read when it already grabbed it via `scanClaudeMd`. Passing
   *  `undefined` (the default) keeps the standalone signature working
   *  for tests and ad-hoc callers. */
  preread?: string | null
): Promise<ClaudeMdAuditInfo> {
  const claudeMdPath = path.join(projectPath, "CLAUDE.md");

  let raw: string | undefined;
  let fileBytes = 0;
  if (typeof preread === "string") {
    raw = preread;
    fileBytes = Buffer.byteLength(raw, "utf-8");
  } else if (preread === null) {
    // Caller already determined CLAUDE.md is missing — skip the read.
    raw = undefined;
  } else {
    try {
      raw = await fs.readFile(claudeMdPath, "utf-8");
      fileBytes = Buffer.byteLength(raw, "utf-8");
    } catch {
      raw = undefined;
    }
  }

  if (!raw) {
    return {
      score: 0,
      projectLines: 0,
      importCount: 0,
      fileBytes: 0,
      rulesLines: 0,
      rulesFileCount: 0,
      hasClaudeMd: false,
      findings: [
        {
          code: "no-claude-md",
          severity: "P1",
          title: "No CLAUDE.md found",
          fix: "Create a CLAUDE.md to give Claude Code project context.",
          penalty: 0,
        },
      ],
    };
  }

  // Independent IO branches: project @imports, sibling-md sniff for the
  // missing-topic-files heuristic, and the rules tree. Fan out so a
  // 60-project scan doesn't serialize them. (User-scope CLAUDE.md is no
  // longer aggregated here — long-index is project-only and the user file
  // is the same across every project.)
  const rulesRoot = path.join(projectPath, ".claude", "rules");
  const [projectExpanded, siblingMd, rulesFiles] = await Promise.all([
    expandImports(claudeMdPath, raw),
    hasSiblingMd(projectPath),
    walkMdTree(rulesRoot),
  ]);

  const projectLines = projectExpanded.content.split(/\r?\n/).length;

  const findings: ClaudeMdAuditFinding[] = [];

  // Long-index — tiered, project-only. NOT a hard truncation; the penalty
  // tracks practitioner heuristics about instruction-following degradation.
  if (projectLines > LONG_INDEX_SEVERE_LINES) {
    findings.push({
      code: "long-index",
      severity: "P0",
      title: `${projectLines} lines — past the practical instruction-following budget; expect rule drop and slower responses`,
      fix: LONG_INDEX_FIX,
      penalty: 15,
      file: claudeMdPath,
    });
  } else if (projectLines > LONG_INDEX_HEAVY_LINES) {
    findings.push({
      code: "long-index",
      severity: "P1",
      title: `${projectLines} lines — past the soft heuristic where rule adherence starts degrading`,
      fix: LONG_INDEX_FIX,
      penalty: 8,
      file: claudeMdPath,
    });
  } else if (projectLines > LONG_INDEX_LIGHT_LINES) {
    findings.push({
      code: "long-index",
      severity: "P2",
      title: `${projectLines} lines — large CLAUDE.md; trimming usually helps response quality`,
      fix: LONG_INDEX_FIX,
      penalty: 3,
      file: claudeMdPath,
    });
  }

  // File size — Claude Code itself surfaces a warning at the warn threshold.
  const warnKB = FILE_SIZE_WARN_BYTES / 1024;
  if (fileBytes > FILE_SIZE_SEVERE_BYTES) {
    findings.push({
      code: "file-size",
      severity: "P0",
      title: `CLAUDE.md is ${formatKB(fileBytes)} — well past Claude Code's ${warnKB} KB warn threshold; severe per-turn token cost`,
      fix: FILE_SIZE_FIX,
      penalty: 20,
      file: claudeMdPath,
    });
  } else if (fileBytes > FILE_SIZE_WARN_BYTES) {
    findings.push({
      code: "file-size",
      severity: "P1",
      title: `CLAUDE.md is ${formatKB(fileBytes)} — Claude Code warns at ${warnKB} KB; CLAUDE.md is injected every turn`,
      fix: FILE_SIZE_FIX,
      penalty: 10,
      file: claudeMdPath,
    });
  }

  const bloated = countBloatedSections(projectExpanded.content);
  const bloatPenalty = inlineBloatPenalty(bloated);
  if (bloatPenalty > 0) {
    findings.push({
      code: "inline-bloat",
      severity: bloated >= 3 ? "P1" : "P2",
      title: `${bloated} section${bloated === 1 ? "" : "s"} exceed${bloated === 1 ? "s" : ""} ${SECTION_BLOAT_LINE_THRESHOLD} content lines`,
      fix: "Move bullet-heavy sections to dedicated rules files; keep CLAUDE.md a high-signal index.",
      penalty: bloatPenalty,
      file: claudeMdPath,
    });
  }

  if (projectLines > 50 && projectExpanded.imports.length === 0 && !siblingMd) {
    findings.push({
      code: "missing-topic-files",
      severity: "P2",
      title: "No three-layer memory pattern detected",
      fix: "Create .claude/rules/ with topic-scoped .md files and @import them from CLAUDE.md.",
      penalty: 10,
    });
  }

  const rulesLines = rulesFiles.reduce((acc, f) => acc + f.lines, 0);
  const volPenalty = rulesVolumePenalty(rulesLines);
  if (volPenalty > 0) {
    findings.push({
      code: "rules-volume",
      severity: "P1",
      title: `${rulesLines} lines across ${rulesFiles.length} rules files (>${RULES_VOLUME_LINE_THRESHOLD} threshold)`,
      fix: "Audit which rules files are actually @imported on every load — leave on-demand ones unimported.",
      penalty: volPenalty,
    });
  }

  const tieringMatches = rulesFiles.filter(
    (f) => ON_DEMAND_FILENAME_RE.test(path.basename(f.file)) && f.lines > 50
  );
  const tierPenalty = tieringPenalty(tieringMatches.length);
  if (tierPenalty > 0) {
    findings.push({
      code: "reference-tiering",
      severity: "P2",
      title: `${tieringMatches.length} rules file${tieringMatches.length === 1 ? " looks" : "s look"} like reference docs`,
      fix: "Reference/guide/schema docs should be opened on-demand, not loaded into every session.",
      penalty: tierPenalty,
    });
  }

  findings.sort((a, b) => {
    const so = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (so !== 0) return so;
    return b.penalty - a.penalty;
  });

  const totalPenalty = findings.reduce((acc, f) => acc + f.penalty, 0);
  return {
    score: clampScore(100 - totalPenalty),
    projectLines,
    importCount: projectExpanded.imports.length,
    fileBytes,
    rulesLines,
    rulesFileCount: rulesFiles.length,
    hasClaudeMd: true,
    findings,
  };
}
