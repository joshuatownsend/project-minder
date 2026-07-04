export interface TodoInfo {
  total: number;
  completed: number;
  pending: number;
  items: TodoItem[];
}

export interface TodoItem {
  text: string;
  completed: boolean;
  lineNumber?: number;
}

export interface ManualStepEntry {
  date: string;           // "2026-03-17 14:32"
  featureSlug: string;    // "auth"
  title: string;          // "Clerk + Vercel Authentication Setup"
  note?: string;          // entry-level note under the header (e.g. `> archived YYYY-MM-DD — why`)
  steps: ManualStep[];
}

export interface ManualStep {
  text: string;           // "Install Clerk package"
  completed: boolean;
  details: string[];      // indented lines beneath the step
  lineNumber: number;     // 1-based line number for write-back
}

export interface ManualStepsInfo {
  entries: ManualStepEntry[];
  totalSteps: number;
  pendingSteps: number;
  completedSteps: number;
}

export interface InsightEntry {
  id: string;              // hash of content for dedup
  content: string;         // the insight text (between markers)
  sessionId: string;       // which conversation it came from
  date: string;            // ISO timestamp from the JSONL entry
  project: string;         // project slug
  projectPath: string;     // full Windows path
}

export interface InsightsInfo {
  entries: InsightEntry[];
  total: number;
}
