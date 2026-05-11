import type { UsageTurn } from "@/lib/usage/types";

// Shared `makeTurn(overrides)` factory. Several tests under tests/usage/
// (classifier, costCalculator, oneShotDetector, sessionQuality) used to
// roll their own near-identical helper. This file is the single source of
// defaults; per-test overrides remain via the `overrides` arg.
//
// `role` is required to keep call sites honest — the field has no
// universally correct default and the various detectors care about it
// (see sessionQuality's user/assistant split). Defaulting it would
// silently inject `"user"` into tests that meant to assert on assistant
// behavior.

const DEFAULTS: Omit<UsageTurn, "role"> = {
  timestamp: "2026-01-01T00:00:00Z",
  sessionId: "sess-1",
  projectSlug: "test-project",
  projectDirName: "test-project",
  model: "claude-sonnet-4-6",
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  toolCalls: [],
};

export function makeTurn(
  overrides: Partial<UsageTurn> & { role: UsageTurn["role"] },
): UsageTurn {
  return { ...DEFAULTS, ...overrides };
}

/** Convenience for assistant turns — the most common shape. */
export function assistantTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return makeTurn({ role: "assistant", ...overrides });
}

/** Convenience for user turns. */
export function userTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return makeTurn({ role: "user", ...overrides });
}
