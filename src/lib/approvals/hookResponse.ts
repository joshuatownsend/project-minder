// Translate an approval outcome into the JSON Claude Code expects on a
// `PreToolUse` hook's stdout.
//
// Kept separate from the route and from the store so the fail-open
// contract is a pure function with exhaustive tests. This is the one place
// where "we didn't get an answer" becomes "let the user decide in the
// terminal", and a regression here is the difference between a monitoring
// tool and a tool that wedges your session.

import type { ApprovalOutcome } from "./store";

/**
 * `ask` is what makes fail-open work. Claude Code treats it as "no opinion
 * from the hook, run the normal permission flow", which is exactly the
 * pre-existing behaviour. `allow`/`deny` short-circuit that flow.
 */
export type PermissionDecision = "allow" | "deny" | "ask";

export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

/**
 * Map an outcome to a hook decision.
 *
 * The exhaustive switch is load-bearing: adding an `ApprovalOutcome`
 * variant without handling it here becomes a TYPE error rather than a
 * silent fall-through to some default. Given that a wrong default is
 * either "deny everything" or "allow everything", neither is an
 * acceptable thing to reach by accident.
 */
export function buildHookOutput(outcome: ApprovalOutcome): PreToolUseHookOutput {
  const out = (
    permissionDecision: PermissionDecision,
    permissionDecisionReason: string
  ): PreToolUseHookOutput => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  });

  switch (outcome) {
    case "allow":
      return out("allow", "Approved in Project Minder");
    case "allow_all":
      return out("allow", "Approved in Project Minder (allow all for this session)");
    case "deny":
      // The ONLY path that produces a deny. Absence of an answer never does.
      return out("deny", "Denied in Project Minder");
    case "auto_allow":
      return out("allow", "Auto-approved — session is in allow-all mode");
    case "bypassed":
      // Read-only tools skip the gate. `ask` rather than `allow` on
      // purpose: bypassing the GATE must not also bypass the user's own
      // permission settings. Returning `allow` here would silently
      // auto-approve reads for someone who had chosen to be asked.
      return out("ask", "Read-only tool — not gated by Project Minder");
    case "timeout":
      return out("ask", "Project Minder did not receive a decision in time");
  }
}

/**
 * The fail-open response, for paths that never reach an outcome at all:
 * an unparseable payload, an internal throw, the feature being disabled.
 * Same shape so the hook's stdout parser only ever sees one schema.
 */
export function failOpenHookOutput(reason: string): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
}
