import { promises as fs } from "fs";
import path from "path";
import { ManualStepsInfo, ManualStepEntry, ManualStep } from "../types";

const HEADER_RE = /^##\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;
const COMPLETED_RE = /^\s*-\s*\[x\]\s+(.*)/i;
const PENDING_RE = /^\s*-\s*\[\s\]\s+(.*)/;

export function parseManualStepsMd(content: string): ManualStepsInfo {
  const lines = content.split(/\r?\n/);
  const entries: ManualStepEntry[] = [];
  let currentEntry: ManualStepEntry | null = null;
  let currentStep: ManualStep | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1; // 1-based

    // Check for entry header
    const headerMatch = line.match(HEADER_RE);
    if (headerMatch) {
      currentEntry = {
        date: headerMatch[1].trim(),
        featureSlug: headerMatch[2].trim(),
        title: headerMatch[3].trim(),
        steps: [],
      };
      entries.push(currentEntry);
      currentStep = null;
      continue;
    }

    // Skip separator lines
    if (line.trim() === "---") {
      currentStep = null;
      continue;
    }

    if (!currentEntry) continue;

    // Check for step lines
    const completedMatch = line.match(COMPLETED_RE);
    const pendingMatch = line.match(PENDING_RE);

    if (completedMatch) {
      currentStep = {
        text: completedMatch[1].trim(),
        completed: true,
        details: [],
        lineNumber,
      };
      currentEntry.steps.push(currentStep);
    } else if (pendingMatch) {
      currentStep = {
        text: pendingMatch[1].trim(),
        completed: false,
        details: [],
        lineNumber,
      };
      currentEntry.steps.push(currentStep);
    } else if (currentStep && line.match(/^\s{2,}/) && line.trim()) {
      // Indented detail line
      currentStep.details.push(line.trim());
    }
  }

  const totalSteps = entries.reduce((sum, e) => sum + e.steps.length, 0);
  const completedSteps = entries.reduce(
    (sum, e) => sum + e.steps.filter((s) => s.completed).length,
    0
  );

  return {
    entries,
    totalSteps,
    pendingSteps: totalSteps - completedSteps,
    completedSteps,
  };
}

export async function scanManualStepsMd(
  projectPath: string
): Promise<ManualStepsInfo | undefined> {
  try {
    const content = await fs.readFile(
      path.join(projectPath, "MANUAL_STEPS.md"),
      "utf-8"
    );
    const info = parseManualStepsMd(content);
    return info.totalSteps > 0 ? info : undefined;
  } catch {
    return undefined;
  }
}
