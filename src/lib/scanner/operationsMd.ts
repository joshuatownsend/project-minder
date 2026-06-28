import { promises as fs } from "fs";
import path from "path";
import {
  OperationsInfo,
  OpsRunbookItem,
  OpsRunbookSection,
  OpsSectionKey,
} from "../types";

// ── OPERATIONS.md grammar (Portfolio Command Deck §7) ──────────────────────
//
//   # Operations — <project>
//
//   ## Backups
//   Optional prose describing the backup posture.
//   - [ ] Nightly snapshot to S3
//     `aws s3 sync ...`  (indented detail lines)
//   - [x] Verified restore drill 2026-06
//
//   ## Monitoring & Alerting
//   ## On-call / Escalation
//   ## Secrets & Rotation
//   ## Restore / Disaster Recovery
//   ## <anything else>   → key "other" (passed through, not dropped)
//
// The parser is deliberately tolerant of hand edits: each `## heading` maps to
// one of the five known section keys via a synonym table (case-insensitive,
// substring), and any unrecognized heading is kept as `other` so a
// hand-written runbook is never silently dropped. Checkbox state is recorded
// (`- [ ]` / `- [x]`) for a future writer, but v1 is read-only.

const HEADING_RE = /^##\s+(.*)$/;
const COMPLETED_RE = /^\s*-\s*\[x\]\s+(.*)/i;
const PENDING_RE = /^\s*-\s*\[\s\]\s+(.*)/;

/** Map a `## heading` to a known section key, falling back to "other". */
const SECTION_SYNONYMS: Array<[re: RegExp, key: OpsSectionKey]> = [
  [/backup|snapshot|retention/i, "backups"],
  [/monitor|alert|observability|uptime|metric/i, "monitoring"],
  [/on.?call|escalation|pager|incident contact/i, "oncall"],
  [/secret|rotation|credential|key management|env var/i, "secrets"],
  [/restore|recovery|disaster|runbook|rollback/i, "restore"],
];

function classifyHeading(heading: string): OpsSectionKey {
  for (const [re, key] of SECTION_SYNONYMS) {
    if (re.test(heading)) return key;
  }
  return "other";
}

/**
 * Parse OPERATIONS.md content into structured runbook sections. Pure (no FS).
 * Returns undefined when the file holds no `##` sections.
 */
export function parseOperationsMd(content: string): OperationsInfo | undefined {
  const lines = content.split(/\r?\n/);
  const sections: OpsRunbookSection[] = [];
  let current: OpsRunbookSection | null = null;
  let currentItem: OpsRunbookItem | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const lineNumber = i + 1; // 1-based

    // Section heading: `## <heading>`
    const headingM = line.match(HEADING_RE);
    if (headingM) {
      const heading = headingM[1].trim();
      current = {
        key: classifyHeading(heading),
        heading,
        body: "",
        items: [],
        line: lineNumber,
      };
      sections.push(current);
      currentItem = null;
      continue;
    }

    // Content before the first `## heading` is ignored (e.g. the `# title`).
    if (!current) continue;

    // Checkbox items: `- [ ]` / `- [x]`
    const completedM = line.match(COMPLETED_RE);
    if (completedM) {
      currentItem = {
        text: completedM[1].trim(),
        done: true,
        details: [],
        lineNumber,
      };
      current.items.push(currentItem);
      continue;
    }
    const pendingM = line.match(PENDING_RE);
    if (pendingM) {
      currentItem = {
        text: pendingM[1].trim(),
        done: false,
        details: [],
        lineNumber,
      };
      current.items.push(currentItem);
      continue;
    }

    // Indented continuation line → detail of the last item. Uses the raw line
    // so leading indentation is what's tested.
    if (currentItem && /^\s{2,}\S/.test(raw)) {
      currentItem.details.push(raw.trim());
      continue;
    }

    // A blank line ends detail capture (but keeps the section context).
    if (line.trim() === "") {
      currentItem = null;
      continue;
    }

    // Otherwise: a non-checkbox prose line → accumulate into the section body.
    const text = line.trim();
    current.body = current.body ? `${current.body}\n${text}` : text;
    currentItem = null;
  }

  if (sections.length === 0) return undefined;

  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  const pendingItems = sections.reduce(
    (n, s) => n + s.items.filter((it) => !it.done).length,
    0,
  );
  return { sections, totalItems, pendingItems };
}

/** Read OPERATIONS.md from a project root. Returns undefined if absent/empty. */
export async function scanOperationsMd(
  projectPath: string,
): Promise<OperationsInfo | undefined> {
  try {
    // Literal filename in the join (not a parameter) so static analysis sees a
    // fixed path component — mirrors the boardMd / manualStepsMd scanners.
    const content = await fs.readFile(
      path.join(projectPath, "OPERATIONS.md"),
      "utf-8",
    );
    return parseOperationsMd(content);
  } catch {
    return undefined;
  }
}

/**
 * On-demand read of OPERATIONS.archive.md (the done/obsolete runbook lane). The
 * scan orchestrator never reads archive files — same convention as
 * scanBoardArchive / scanManualStepsArchive — so active counts stay clean.
 */
export async function scanOperationsArchive(
  projectPath: string,
): Promise<OperationsInfo | undefined> {
  try {
    const content = await fs.readFile(
      path.join(projectPath, "OPERATIONS.archive.md"),
      "utf-8",
    );
    return parseOperationsMd(content);
  } catch {
    return undefined;
  }
}
