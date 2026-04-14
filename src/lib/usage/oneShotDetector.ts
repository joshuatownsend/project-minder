import type { UsageTurn, OneShotStats } from "@/lib/usage/types";

const EDIT_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

const VERIFICATION_PATTERN =
  /\b(test|vitest|jest|pytest|npm test|npm run test|build|lint|tsc|eslint|check)\b/i;

const ERROR_PATTERNS = [
  /\bFAIL\b/,
  /\bError:/,
  /\bTypeError\b/,
  /\bSyntaxError\b/,
  /exit code [1-9]/i,
  /\bERROR\b/,
  /\bfailed\b/i,
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

export function detectOneShot(turns: UsageTurn[]): OneShotStats {
  let totalVerifiedTasks = 0;
  let oneShotTasks = 0;

  // Walk through the turns looking for: assistant(edit) → assistant(bash verify) → user(result) → assistant(next)
  // Turns can be interleaved: assistant turns may have multiple tool calls, user turns carry tool results.

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];

    // A task starts on an assistant turn containing an Edit/Write tool call
    if (turn.role !== "assistant" || !hasEditOrWrite(turn)) continue;

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
      totalVerifiedTasks++;
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

    totalVerifiedTasks++;
    if (!reEdited) {
      oneShotTasks++;
    }

    // Advance past the result turn
    i = resultUserIdx;
  }

  const rate = totalVerifiedTasks === 0 ? 0 : oneShotTasks / totalVerifiedTasks;
  return { totalVerifiedTasks, oneShotTasks, rate };
}
