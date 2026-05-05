import { createReadStream } from "fs";
import { createInterface } from "readline";
import path from "path";
import { extractFileEdits } from "./fileActivity";
import { extractBashCommands, extractBinary } from "./shellParser";
import type { UsageTurn } from "./types";

export interface GitCommitFact {
  message: string;
  bodyLines?: string[];
}

export interface HandoffFacts {
  filesModified: string[];
  filesRead: string[];
  gitCommits: GitCommitFact[];
  keyCommands: string[];
  firstUserPrompt?: string;
  lastAssistantText?: string;
}

export interface CompactionFidelity {
  summary: string;
  factsTotal: number;
  factsMentioned: number;
  score: number;
  isLowFidelity: boolean;
  missingFacts: string[];
}

// ─── JSONL bash command skip list (single-token trivial commands) ─────────────

const SKIP_BINARIES = new Set([
  "echo", "ls", "pwd", "cd", "cat", "head", "tail", "grep", "find", "wc",
  "clear", "which", "where", "type", "dir", "mkdir", "rmdir", "rm", "cp",
  "mv", "touch", "date", "time", "sleep", "exit", "source", "export",
  "set", "unset", "env", "printenv",
]);

// ─── Fact extraction ──────────────────────────────────────────────────────────

export function extractHandoffFacts(turns: UsageTurn[]): HandoffFacts {
  // Single pass over file edits: split into modified vs read-only
  const modifiedSet = new Set<string>();
  const readSet = new Set<string>();
  for (const edit of extractFileEdits(turns)) {
    if (edit.op === "read") readSet.add(edit.filePath);
    else modifiedSet.add(edit.filePath);
  }
  // A file that was both read and modified belongs only in modified
  for (const p of modifiedSet) readSet.delete(p);

  // Git commits from Bash tool calls
  const gitCommits: GitCommitFact[] = [];
  // Key commands (non-trivial, deduped)
  const keyCommandSet = new Set<string>();

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const cmd of extractBashCommands(turn)) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;

      // Git commit detection
      if (/\bgit\s+commit\b/.test(trimmed)) {
        const fact = parseGitCommitMessage(trimmed);
        if (fact) gitCommits.push(fact);
        continue;
      }

      // Key commands: skip trivial binaries and short commands
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const binary = extractBinary(trimmed);
      if (tokens.length > 4 && !SKIP_BINARIES.has(binary)) {
        // Normalise: strip dynamic args (paths, SHAs) for dedup
        keyCommandSet.add(normalizeCommand(trimmed));
      }
    }
  }

  const firstUserTurn = turns.find((t) => t.role === "user");
  let lastAssistantTurn: UsageTurn | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant" && turns[i].assistantText) {
      lastAssistantTurn = turns[i];
      break;
    }
  }

  return {
    filesModified: [...modifiedSet],
    filesRead: [...readSet],
    gitCommits,
    keyCommands: [...keyCommandSet].slice(0, 30),
    firstUserPrompt: firstUserTurn?.userMessageText,
    lastAssistantText: lastAssistantTurn?.assistantText,
  };
}

// ─── Git commit message parser ────────────────────────────────────────────────

function parseGitCommitMessage(command: string): GitCommitFact | null {
  // Form 2 first: HEREDOC -m "$(cat <<'EOF'\n...\nEOF\n)" — must precede simple
  // -m check since the heredoc command also matches the simple -m regex.
  const heredocMatch = command.match(
    /git\s+commit\b[^(]*\(cat\s+<<['"]{0,1}EOF['"]{0,1}\n([\s\S]*?)\nEOF/
  );
  if (heredocMatch) {
    const lines = heredocMatch[1]
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((_, i, arr) => i < arr.length - 1 || arr[i].trim() !== "");
    return {
      message: lines[0]?.trim() ?? "<heredoc>",
      bodyLines: lines.slice(1).length > 0 ? lines.slice(1) : undefined,
    };
  }

  // Form 1: simple git commit -m "message" (no heredoc)
  const shortMatch = command.match(/git\s+commit\b[^"']*(?:-m\s*)(["'])([\s\S]*?)\1/);
  if (shortMatch) {
    const raw = shortMatch[2];
    const lines = raw.split(/\r?\n/);
    return {
      message: lines[0].trim(),
      bodyLines:
        lines.length > 1
          ? lines
              .slice(1)
              .map((l) => l.trim())
              .filter(Boolean)
          : undefined,
    };
  }

  // Form 3: git commit with --message= flag
  const longMatch = command.match(/--message=["']?([\s\S]*?)["']?(?:\s|$)/);
  if (longMatch) {
    return { message: longMatch[1].trim() };
  }

  return { message: "<commit message unparsed>" };
}

function normalizeCommand(command: string): string {
  // Keep the first 80 chars; strip trailing flags that vary per-invocation
  return command.slice(0, 80).trimEnd();
}

// ─── Compaction summary reader ────────────────────────────────────────────────

/**
 * Scans a JSONL session file for the first compact_boundary or compact_summary
 * record and returns its text content. Returns null when none exists.
 *
 * Handles four known record shapes emitted by different Claude Code versions:
 *   1. {"type":"system","subtype":"compact_boundary","summary":"..."}
 *   2. {"type":"compact_summary","text":"..."}
 *   3. {"compactSummary":"..."}
 *   4. {"type":"system","content":"... [compact summary follows] ..."}
 */
export function readCompactionSummary(
  sessionJsonlPath: string
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(sessionJsonlPath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let found = false;

    rl.on("line", (line) => {
      if (found) return;
      if (!line.trim()) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      // Shape 1: system + compact_boundary subtype
      if (obj.type === "system" && obj.subtype === "compact_boundary") {
        const summary =
          typeof obj.summary === "string"
            ? obj.summary
            : typeof obj.text === "string"
              ? obj.text
              : null;
        if (summary) {
          found = true;
          rl.close(); stream.destroy();
          resolve(summary);
          return;
        }
      }

      // Shape 2: compact_summary type
      if (obj.type === "compact_summary") {
        const text = typeof obj.text === "string" ? obj.text : null;
        if (text) {
          found = true;
          rl.close(); stream.destroy();
          resolve(text);
          return;
        }
      }

      // Shape 3: top-level compactSummary field
      if (typeof obj.compactSummary === "string" && obj.compactSummary) {
        found = true;
        rl.close(); stream.destroy();
        resolve(obj.compactSummary);
        return;
      }

      // Shape 4: message.content array with compact marker text
      // (older versions embed the summary in the text of a system message)
      if (obj.type === "system" && typeof obj.content === "string") {
        const content = obj.content as string;
        if (
          content.includes("[compact summary]") ||
          content.includes("compact_boundary")
        ) {
          found = true;
          rl.close(); stream.destroy();
          resolve(content);
          return;
        }
      }
    });

    rl.on("close", () => {
      if (!found) resolve(null);
    });

    stream.on("error", (err: NodeJS.ErrnoException) => {
      found = true; // prevent rl "close" from resolving null after we settle
      rl.close();
      stream.destroy();
      if (err.code === "ENOENT") {
        resolve(null);
      } else {
        reject(err);
      }
    });

    // readline re-emits stream errors on the interface; absorb them here
    // since the underlying stream error is already handled above.
    rl.on("error", () => {});
  });
}

// ─── Fidelity scoring ─────────────────────────────────────────────────────────

const MAX_FACTS = 50;

export function scoreCompactionFidelity(
  facts: HandoffFacts,
  summary: string
): CompactionFidelity {
  const summaryLower = summary.toLowerCase();

  // Build needles: basename for files, first 6 words for commit messages,
  // binary name for commands.
  const allNeedles: string[] = [
    ...facts.filesModified.map((p) => path.basename(p).toLowerCase()),
    ...facts.filesRead.map((p) => path.basename(p).toLowerCase()),
    ...facts.gitCommits.map((c) =>
      c.message
        .toLowerCase()
        .split(/\s+/)
        .slice(0, 6)
        .join(" ")
    ),
    ...facts.keyCommands.map((c) => extractBinary(c)),
  ].filter(Boolean);

  const needles = allNeedles.slice(0, MAX_FACTS);
  const factsTotal = needles.length;

  if (factsTotal === 0) {
    return {
      summary,
      factsTotal: 0,
      factsMentioned: 0,
      score: 1,
      isLowFidelity: false,
      missingFacts: [],
    };
  }

  // Pre-compile all regexes before the loop to avoid repeated allocation.
  // \b doesn't work with dots in filenames, so we match surrounding non-word chars.
  const compiled = needles.map((needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { needle, re: new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`) };
  });

  const mentioned: string[] = [];
  const missing: string[] = [];

  for (const { needle, re } of compiled) {
    if (re.test(summaryLower)) {
      mentioned.push(needle);
    } else {
      missing.push(needle);
    }
  }

  const factsMentioned = mentioned.length;
  const score = factsMentioned / factsTotal;

  return {
    summary,
    factsTotal,
    factsMentioned,
    score,
    isLowFidelity: score < 0.6,
    missingFacts: missing.slice(0, 10),
  };
}
