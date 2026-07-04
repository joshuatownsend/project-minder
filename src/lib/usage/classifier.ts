import type { UsageTurn, CategoryType } from "@/lib/usage/types";

const GIT_OPS_RE =
  /\bgit\s+(commit|push|pull|merge|rebase|checkout|branch|stash|cherry-pick|reset|revert|tag|log|diff|show|fetch|clone|status|add)\b/i;

const BUILD_DEPLOY_RE =
  /\b(npm run build|yarn build|pnpm build|docker build|docker compose|vercel|netlify|deploy|webpack|vite build|next build|tsc\b)/i;

const TESTING_CMD_RE =
  /\b(vitest|jest|pytest|mocha|cypress|playwright|npm test|npm run test)\b/i;

// Tightened so bare "fix"/"issue" in ordinary prose ("fix the copy",
// "issue the refund") no longer over-tag Debugging (A7). Matches: strong
// debugging keywords on their own; a fix/solve/diagnose verb sitting near a
// debugging noun; or the reasonably specific bare words "error"/"bug". Tool
// error context is handled separately by the `isError` short-circuit below.
const DEBUGGING_RE =
  /\b(debug(?:ging|ged)?|traceback|stack.?trace|stacktrace|exception|crash(?:ed|ing|es)?|broken|regression|segfault)\b|\b(?:fix|fixing|solve|solving|resolve|resolving|diagnose|troubleshoot|debugging)\b[\s\S]{0,40}\b(?:bug|error|crash|exception|failure|fail(?:ing|s|ed)?|traceback|regression|not\s+working)\b|\b(?:error|bug)s?\b/i;

const REFACTORING_RE =
  /\b(refactor|rename|extract|move|reorganize|clean.?up|simplify|restructure)\b/i;

const PLANNING_RE =
  /\b(plan|design|architect|strategy|approach|roadmap|spec|requirements|RFC)\b/i;

const BRAINSTORM_RE =
  /\b(brainstorm|ideas?|creative|suggest|alternatives|options|possibilities)\b/i;

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "Bash", "PowerShell", "MultiEdit"]);

export function classifyTurn(turn: UsageTurn): CategoryType {
  const { toolCalls, userMessageText, role, isError } = turn;
  const hasTools = toolCalls.length > 0;

  // Intent text used by the Debugging/Refactoring/Planning/Brainstorming
  // rules. A token-bearing assistant turn carries no `userMessageText` of its
  // own, so we fall back to `userIntentText` — the triggering user prompt
  // propagated onto the turn by both parser backends. Without this, those
  // intent categories could never attribute an assistant turn's cost (A3).
  const intentText = userMessageText ?? turn.userIntentText;

  // Helper: get command from Bash/PowerShell tool call
  const getCommand = (name: string, args?: Record<string, unknown>): string | undefined => {
    if (name === "Bash" || name === "PowerShell") {
      return typeof args?.command === "string" ? args.command : undefined;
    }
    return undefined;
  };

  // 1. Git Ops
  for (const tc of toolCalls) {
    const cmd = getCommand(tc.name, tc.arguments);
    if (cmd && GIT_OPS_RE.test(cmd)) return "Git Ops";
  }

  // 2. Build/Deploy
  for (const tc of toolCalls) {
    const cmd = getCommand(tc.name, tc.arguments);
    if (cmd && BUILD_DEPLOY_RE.test(cmd)) return "Build/Deploy";
  }

  // 3. Testing
  for (const tc of toolCalls) {
    const cmd = getCommand(tc.name, tc.arguments);
    if (cmd && TESTING_CMD_RE.test(cmd)) return "Testing";
    // Edit/Write targeting test file
    if ((tc.name === "Edit" || tc.name === "Write") && typeof tc.arguments?.file_path === "string") {
      if (tc.arguments.file_path.includes("test")) return "Testing";
    }
  }

  // 4. Debugging
  if (isError) return "Debugging";
  if (intentText && DEBUGGING_RE.test(intentText)) return "Debugging";

  // 5. Refactoring
  if (intentText && REFACTORING_RE.test(intentText)) return "Refactoring";

  // 6. Delegation
  for (const tc of toolCalls) {
    if (tc.name === "Agent" || tc.name === "Skill") return "Delegation";
  }

  // 7. Planning (no tool calls)
  if (!hasTools && intentText && PLANNING_RE.test(intentText)) return "Planning";

  // 8. Brainstorming (no tool calls)
  if (!hasTools && intentText && BRAINSTORM_RE.test(intentText)) return "Brainstorming";

  // 9. Exploration: all tool calls are read-only, at least one
  if (hasTools) {
    const allReadOnly = toolCalls.every((tc) => READ_ONLY_TOOLS.has(tc.name));
    const noneWrite = toolCalls.every((tc) => !WRITE_TOOLS.has(tc.name));
    if (allReadOnly && noneWrite) return "Exploration";
  }

  // 10. Feature Dev: any Write tool call
  for (const tc of toolCalls) {
    if (tc.name === "Write") return "Feature Dev";
  }

  // 11. Coding: any Edit, Write, Bash, or PowerShell
  for (const tc of toolCalls) {
    if (tc.name === "Edit" || tc.name === "Write" || tc.name === "Bash" || tc.name === "PowerShell") {
      return "Coding";
    }
  }

  // 12. Conversation: assistant with no tool calls
  if (role === "assistant" && !hasTools) return "Conversation";

  // 13. General fallback
  return "General";
}
