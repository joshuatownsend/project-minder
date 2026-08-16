import type { HarnessConfig } from "@/lib/adapters/types";

/**
 * Synthetic harness-config snapshot for demo mode.
 *
 * `/api/adapters/[id]/config` returns the adapter's real `home` path plus the
 * *contents* of its rules files — an unredacted read of the user's harness
 * setup. (Its sibling `/api/adapters` is NOT a leak: it lists the code-defined
 * adapter registry plus enabled flags, so it is deliberately left alone.)
 *
 * Shaped as "present, configured, unremarkable" so the panel demonstrates what
 * it is for. The demo home is obviously synthetic by construction.
 */
export function demoHarnessConfig(harnessId: string, displayName: string): HarnessConfig {
  return {
    harnessId,
    displayName,
    home: `C:\\Users\\demo\\.${harnessId}`,
    present: true,
    config: {
      model: "claude-opus-5",
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
    },
    rules: [
      {
        name: "AGENTS.md",
        content:
          "# Working agreement\n\n" +
          "- Run the test suite before proposing a commit.\n" +
          "- Prefer the smallest change that closes the issue.\n" +
          "- Record manual steps in MANUAL_STEPS.md rather than in chat.\n",
        truncated: false,
      },
    ],
    resources: [
      { name: "sessions", present: true },
      { name: "archived_sessions", present: true },
      { name: "log", present: false },
    ],
  };
}
