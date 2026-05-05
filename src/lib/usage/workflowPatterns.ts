import { extractBashCommands, extractBinary } from "./shellParser";
import type { UsageTurn, SkillStats } from "./types";
import type { SkillEntry } from "@/lib/indexer/types";

export interface WorkflowPattern {
  fingerprint: string;
  binaries: string[];
  occurrences: number;
  totalRuns: number;
  sampleSessionIds: string[];
  suggestedSkillName?: string;
  matchedSkill?: { id: string; name: string; invocations: number };
}

export interface WorkflowPatternsInput {
  turns: UsageTurn[];
  sequenceLengths?: number[];
  minSessions?: number;
  skillsCatalog?: SkillEntry[];
  skillUsage?: SkillStats[];
}

export interface WorkflowPatternsResult {
  patterns: WorkflowPattern[];
  totalSessionsConsidered: number;
  totalBashCalls: number;
}

const MAX_PATTERNS = 50;

export function detectWorkflowPatterns(
  input: WorkflowPatternsInput
): WorkflowPatternsResult {
  const {
    turns,
    sequenceLengths = [2, 3, 4],
    minSessions = 3,
    skillsCatalog,
    skillUsage,
  } = input;

  // Group turns by sessionId in insertion order
  const sessionTurns = new Map<string, UsageTurn[]>();
  let totalBashCalls = 0;
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const arr = sessionTurns.get(turn.sessionId) ?? [];
    arr.push(turn);
    sessionTurns.set(turn.sessionId, arr);
  }

  // Build per-session binary sequences
  const sessionSequences = new Map<string, string[]>();
  for (const [sessionId, sessionTurnList] of sessionTurns) {
    const binaries: string[] = [];
    for (const t of sessionTurnList) {
      for (const cmd of extractBashCommands(t)) {
        const binary = extractBinary(cmd);
        if (binary && binary !== "unknown") {
          binaries.push(binary);
          totalBashCalls++;
        }
      }
    }
    if (binaries.length > 0) {
      sessionSequences.set(sessionId, binaries);
    }
  }

  // N-gram accumulation
  interface Accumulator {
    sessions: Set<string>;
    runs: number;
    binaries: string[];
    sampleSessionIds: string[];
  }
  const ngrams = new Map<string, Accumulator>();

  for (const [sessionId, sequence] of sessionSequences) {
    for (const n of sequenceLengths) {
      if (sequence.length < n) continue;
      const seenInSession = new Set<string>();
      for (let i = 0; i <= sequence.length - n; i++) {
        const window = sequence.slice(i, i + n);
        // Skip all-identical windows (too noisy)
        if (window.every((b) => b === window[0])) continue;
        const fingerprint = window.join(">");
        seenInSession.add(fingerprint);

        const acc = ngrams.get(fingerprint) ?? {
          sessions: new Set<string>(),
          runs: 0,
          binaries: window,
          sampleSessionIds: [],
        };
        acc.runs++;
        ngrams.set(fingerprint, acc);
      }
      // Add session membership only once per session per fingerprint
      for (const fingerprint of seenInSession) {
        const acc = ngrams.get(fingerprint)!;
        if (!acc.sessions.has(sessionId)) {
          acc.sessions.add(sessionId);
          if (acc.sampleSessionIds.length < 5) {
            acc.sampleSessionIds.push(sessionId);
          }
        }
      }
    }
  }

  // Filter by minSessions threshold
  const filtered = [...ngrams.entries()]
    .filter(([, acc]) => acc.sessions.size >= minSessions)
    .sort((a, b) => {
      const occDiff = b[1].sessions.size - a[1].sessions.size;
      return occDiff !== 0 ? occDiff : b[1].runs - a[1].runs;
    })
    .slice(0, MAX_PATTERNS);

  // Build skill usage lookup
  const skillUsageMap = new Map<string, number>();
  if (skillUsage) {
    for (const s of skillUsage) {
      skillUsageMap.set(s.name.toLowerCase(), s.invocations);
    }
  }

  // Build catalog lookup
  const skillCatalogMap = new Map<
    string,
    { id: string; name: string; description?: string }
  >();
  if (skillsCatalog) {
    for (const s of skillsCatalog) {
      skillCatalogMap.set(s.name.toLowerCase(), {
        id: s.id,
        name: s.name,
        description: s.description,
      });
    }
  }

  const patterns: WorkflowPattern[] = filtered.map(([fingerprint, acc]) => {
    const suggestedSkillName = buildSkillName(acc.binaries);
    const matchedSkill = matchSkill(
      acc.binaries,
      suggestedSkillName,
      skillCatalogMap,
      skillUsageMap
    );

    return {
      fingerprint,
      binaries: acc.binaries,
      occurrences: acc.sessions.size,
      totalRuns: acc.runs,
      sampleSessionIds: acc.sampleSessionIds,
      suggestedSkillName,
      matchedSkill,
    };
  });

  return {
    patterns,
    totalSessionsConsidered: sessionSequences.size,
    totalBashCalls,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSkillName(binaries: string[]): string {
  const name = [...binaries, "flow"].join("-");
  return name.length > 40 ? name.slice(0, 37) + "..." : name;
}

function matchSkill(
  binaries: string[],
  suggestedName: string,
  catalog: Map<string, { id: string; name: string; description?: string }>,
  usageMap: Map<string, number>
): WorkflowPattern["matchedSkill"] {
  if (catalog.size === 0) return undefined;

  const searchTokens = new Set([
    ...binaries,
    ...suggestedName
      .toLowerCase()
      .replace(/-flow$/, "")
      .split("-")
      .filter(Boolean),
  ]);

  let bestEntry: { id: string; name: string } | undefined;
  let bestScore = 1; // require at least 2 overlapping tokens

  for (const [key, entry] of catalog) {
    const entryTokens = [
      ...key.split(/[\s\-_]+/),
      ...(entry.description ?? "")
        .toLowerCase()
        .split(/\s+/)
        .slice(0, 20),
    ].filter(Boolean);
    let overlap = 0;
    for (const token of entryTokens) {
      if (searchTokens.has(token)) overlap++;
    }
    if (overlap > bestScore) {
      bestScore = overlap;
      bestEntry = { id: entry.id, name: entry.name };
    }
  }

  if (!bestEntry) return undefined;
  return {
    id: bestEntry.id,
    name: bestEntry.name,
    invocations: usageMap.get(bestEntry.name.toLowerCase()) ?? 0,
  };
}
