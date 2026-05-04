import { promises as fs } from "fs";
import path from "path";
import { expandImports } from "./expandImports";
import { walkMdTree } from "./mdTreeWalk";
import { readUserClaudeMdContent } from "./userClaudeMd";
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
 *   - Visibility cap: Claude Code truncates CLAUDE.md/MEMORY.md at 200 lines.
 *     visibility% = min(lines, 200) / total_lines × 100.
 *     Penalty = (100 - visibility%) × 0.5
 *   - File size:     any index file >25 KB → -10
 *   - Inline bloat:  sections (`#`-headed) with >5 non-empty content lines
 *                    → -3 to -15 (scaled by section count)
 *   - Missing topic files: index >50 lines and no sibling `.md` files → -10
 *   - Rules volume: total `.claude/rules/**.md` lines >2000 → -5 to -20
 *   - Reference tiering: rules files matching reference/guide/template/...
 *                        and >50 lines should be on-demand → -2 to -10
 *
 * Counts are computed from the @import-expanded, comment-stripped content
 * so the score reflects on-load token cost, not the raw index byte count.
 */

const MAX_VISIBILITY_LINES = 200;
const MAX_INDEX_FILE_BYTES = 25 * 1024;
const SECTION_BLOAT_LINE_THRESHOLD = 5;
const RULES_VOLUME_LINE_THRESHOLD = 2000;
const ON_DEMAND_FILENAME_RE = /(reference|guide|template|example|sql|database|api|schema|migration)/i;

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

export async function auditClaudeMd(projectPath: string): Promise<ClaudeMdAuditInfo> {
  const claudeMdPath = path.join(projectPath, "CLAUDE.md");

  let raw: string | undefined;
  let fileBytes = 0;
  try {
    raw = await fs.readFile(claudeMdPath, "utf-8");
    fileBytes = Buffer.byteLength(raw, "utf-8");
  } catch {
    raw = undefined;
  }

  if (!raw) {
    return {
      score: 0,
      totalLines: 0,
      visibleLines: 0,
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

  // Independent IO branches: project @imports, user-scope CLAUDE.md (cached
  // per-mtime), sibling-md sniff for the missing-topic-files heuristic, and
  // the rules tree. Fan out so a 60-project scan doesn't serialize them.
  const rulesRoot = path.join(projectPath, ".claude", "rules");
  const [projectExpanded, userExpandedContent, siblingMd, rulesFiles] = await Promise.all([
    expandImports(claudeMdPath, raw),
    readUserClaudeMdContent(),
    hasSiblingMd(projectPath),
    walkMdTree(rulesRoot),
  ]);

  const fullContent = userExpandedContent
    ? `${userExpandedContent}\n${projectExpanded.content}`
    : projectExpanded.content;
  const lines = fullContent.split(/\r?\n/);
  const totalLines = lines.length;
  const visibleLines = Math.min(totalLines, MAX_VISIBILITY_LINES);

  const findings: ClaudeMdAuditFinding[] = [];

  if (totalLines > MAX_VISIBILITY_LINES) {
    const visibilityPct = (visibleLines / totalLines) * 100;
    const penalty = Math.round((100 - visibilityPct) * 0.5);
    findings.push({
      code: "visibility-cap",
      severity: "P0",
      title: `${totalLines} lines — only first ${MAX_VISIBILITY_LINES} are loaded by Claude Code`,
      fix: "Move detail into separate .claude/rules/ files and @import only what's always relevant.",
      penalty,
      file: claudeMdPath,
    });
  }

  if (fileBytes > MAX_INDEX_FILE_BYTES) {
    findings.push({
      code: "file-size",
      severity: "P1",
      title: `CLAUDE.md is ${(fileBytes / 1024).toFixed(1)} KB (>${MAX_INDEX_FILE_BYTES / 1024} KB threshold)`,
      fix: "Split out long sections into topic-scoped .md files referenced by @import.",
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

  const projectRawLines = projectExpanded.content.split(/\r?\n/).length;
  if (projectRawLines > 50 && projectExpanded.imports.length === 0 && !siblingMd) {
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
    totalLines,
    visibleLines,
    importCount: projectExpanded.imports.length,
    fileBytes,
    rulesLines,
    rulesFileCount: rulesFiles.length,
    hasClaudeMd: true,
    findings,
  };
}
