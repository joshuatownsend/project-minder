import type { UsageTurn, OneShotStats } from "@/lib/usage/types";

/**
 * One verified task located by the detector, reported against the turn that
 * *started* it — the assistant turn carrying the Edit/Write.
 *
 * A task spans several turns (edit → verify → result), so attributing it to a
 * single turn is a choice, not a fact. The anchor is the edit turn because
 * that is the turn whose work the verification judges: it answers "when the
 * model produced this change, did it pass first time?". The verification turn
 * may carry a different `effort`, model, or skill; those are not what the
 * outcome is measuring.
 *
 * Anchoring here rather than at each consumer is what keeps the file-parse and
 * SQLite backends reporting the same number — `turns.task_outcome` is written
 * from this index at ingest, and the aggregator buckets from the same one.
 */
export interface OneShotTask {
  /** Index into the `turns` array passed to the detector. */
  anchorIndex: number;
  /** Verification passed and no re-edit followed. */
  oneShot: boolean;
}

export const EDIT_WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

export const VERIFICATION_PATTERN =
  /\b(test|vitest|jest|pytest|npm test|npm run test|build|lint|tsc|eslint|check)\b/i;

const ERROR_PATTERNS = [
  /\bFAIL\b/,
  /\bError:/,
  /\bTypeError\b/,
  /\bSyntaxError\b/,
  /exit code [1-9]/i,
  /\bERROR\b/,
  /(?<!\b0\s)\bfailed\b/i,
];

function hasEditOrWrite(turn: UsageTurn): boolean {
  return turn.toolCalls.some((tc) => EDIT_WRITE_TOOLS.has(tc.name));
}

function isVerificationBash(turn: UsageTurn): boolean {
  for (const tc of turn.toolCalls) {
    if (tc.name === "Bash" || tc.name === "PowerShell") {
      const cmd: string =
        typeof tc.arguments?.command === "string" ? tc.arguments.command : "";
      if (VERIFICATION_PATTERN.test(cmd)) {
        return true;
      }
    }
  }
  return false;
}

function hasErrorInResult(text: string | undefined): boolean {
  if (!text) return false;
  return ERROR_PATTERNS.some((re) => re.test(text));
}

/**
 * Locate every verified task in a turn sequence and report each one's outcome
 * against its anchor turn. `detectOneShot` is a fold over this — the walk
 * lives here once so the counts and the per-turn attribution can never drift.
 */
export function detectOneShotTasks(turns: UsageTurn[]): OneShotTask[] {
  const tasks: OneShotTask[] = [];

  // Walk through the turns looking for: assistant(edit) → assistant(bash verify) → user(result) → assistant(next)
  // Turns can be interleaved: assistant turns may have multiple tool calls, user turns carry tool results.

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];

    // A task starts on an assistant turn containing an Edit/Write tool call
    if (turn.role !== "assistant" || !hasEditOrWrite(turn)) continue;

    // Captured before the loop counter is advanced past the result turn below.
    const anchorIndex = i;

    // Look forward for a verification step (Bash/PowerShell with test/build pattern)
    // The verification could be on the same assistant turn or a subsequent one,
    // but must come before the next edit turn.
    let verifyAssistantIdx = -1;

    // Check the current turn first
    if (isVerificationBash(turn)) {
      verifyAssistantIdx = i;
    } else {
      // Scan subsequent turns for a verification step, stopping at the next edit
      for (let j = i + 1; j < turns.length; j++) {
        const t = turns[j];
        if (t.role === "assistant" && hasEditOrWrite(t)) break; // new task started, no verification found
        if (t.role === "assistant" && isVerificationBash(t)) {
          verifyAssistantIdx = j;
          break;
        }
      }
    }

    if (verifyAssistantIdx === -1) {
      // No verification step for this task — exclude from count
      continue;
    }

    // Find the user turn immediately after the verification assistant turn (carries tool result)
    let resultUserIdx = -1;
    for (let j = verifyAssistantIdx + 1; j < turns.length; j++) {
      if (turns[j].role === "user") {
        resultUserIdx = j;
        break;
      }
    }

    if (resultUserIdx === -1) {
      // No result turn found — cannot determine success
      continue;
    }

    const resultTurn = turns[resultUserIdx];
    const verificationFailed = hasErrorInResult(resultTurn.toolResultText);

    if (verificationFailed) {
      // Not one-shot
      tasks.push({ anchorIndex, oneShot: false });
      // advance i to the result turn so outer loop continues from there
      i = resultUserIdx;
      continue;
    }

    // Verification passed — check if the NEXT assistant turn re-edits
    let nextAssistantIdx = -1;
    for (let j = resultUserIdx + 1; j < turns.length; j++) {
      if (turns[j].role === "assistant") {
        nextAssistantIdx = j;
        break;
      }
    }

    const reEdited =
      nextAssistantIdx !== -1 && hasEditOrWrite(turns[nextAssistantIdx]);

    tasks.push({ anchorIndex, oneShot: !reEdited });

    // Advance past the result turn
    i = resultUserIdx;
  }

  return tasks;
}

/**
 * Fold located tasks into the headline counts. Exported so a caller that
 * already ran `detectOneShotTasks` (ingest, which also needs the anchors) gets
 * the same totals without a second walk.
 */
export function summarizeOneShotTasks(tasks: OneShotTask[]): OneShotStats {
  const totalVerifiedTasks = tasks.length;
  let oneShotTasks = 0;
  for (const t of tasks) {
    if (t.oneShot) oneShotTasks++;
  }
  const rate = totalVerifiedTasks === 0 ? 0 : oneShotTasks / totalVerifiedTasks;
  return { totalVerifiedTasks, oneShotTasks, rate };
}

export function detectOneShot(turns: UsageTurn[]): OneShotStats {
  return summarizeOneShotTasks(detectOneShotTasks(turns));
}
