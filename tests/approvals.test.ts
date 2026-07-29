import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  requestApproval,
  decideApproval,
  listPendingApprovals,
  isSessionAutoAllowed,
  clearSessionAutoAllow,
  _resetApprovalsForTesting,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "@/lib/approvals/store";
import { isReadOnlyTool, readOnlyToolNames } from "@/lib/approvals/readOnlyTools";
import { buildHookOutput, failOpenHookOutput } from "@/lib/approvals/hookResponse";
import { summarizeToolCall } from "@/lib/approvals/summarize";
import { buildApprovalCurlCommand, isManagedCommand } from "@/lib/hooks/curlCommand";

// Tests for the blocking tool-approval gate. Dependency-free — no DB, no
// filesystem, no driver guard.
//
// The three properties under test are safety properties, not features:
// FAIL OPEN (a broken gate must never wedge a session), REPLAY-SAFE (a
// stale decision must not approve a different call), and BOUNDED (a dead
// hook must not leak a pending entry forever).

const req = (over: Partial<Parameters<typeof requestApproval>[0]> = {}) => ({
  sessionId: "sess-1",
  toolName: "Bash",
  summary: "rm -rf ./build",
  ...over,
});

beforeEach(() => _resetApprovalsForTesting());
afterEach(() => {
  _resetApprovalsForTesting();
  vi.useRealTimers();
});

describe("isReadOnlyTool", () => {
  it("allows the documented read-only set through", () => {
    for (const name of ["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoRead"]) {
      expect(isReadOnlyTool(name)).toBe(true);
    }
  });

  it("gates everything consequential", () => {
    // Bash is the single most important one to gate — it can do anything.
    for (const name of [
      "Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit",
      "Agent", "Task", "Skill", "TodoWrite", "KillShell",
    ]) {
      expect(isReadOnlyTool(name)).toBe(false);
    }
  });

  it("gates WebFetch and WebSearch despite them not mutating local state", () => {
    // Deliberate departure from claude-pulse: these EGRESS, and a URL can
    // carry data off the machine.
    expect(isReadOnlyTool("WebFetch")).toBe(false);
    expect(isReadOnlyTool("WebSearch")).toBe(false);
  });

  it("never bypasses an MCP tool", () => {
    // A name-based heuristic would read `mcp__github__get_file_contents`
    // as a read; MCP servers have unknown side effects.
    expect(isReadOnlyTool("mcp__github__get_file_contents")).toBe(false);
    expect(isReadOnlyTool("mcp__anything__Read")).toBe(false);
  });

  it("defaults unknown tools to gated — the allowlist polarity", () => {
    // If this ever inverts, every future Claude Code tool silently skips
    // the gate with nothing surfacing that it happened.
    expect(isReadOnlyTool("SomeToolShippedNextYear")).toBe(false);
    expect(isReadOnlyTool("")).toBe(false);
    expect(isReadOnlyTool(null)).toBe(false);
    expect(isReadOnlyTool(undefined)).toBe(false);
  });

  it("matches exactly, so a prefix cannot smuggle a tool through", () => {
    expect(isReadOnlyTool("ReadAndDelete")).toBe(false);
    expect(isReadOnlyTool("read")).toBe(false);
  });

  it("exposes a sorted list for the settings UI", () => {
    const names = readOnlyToolNames();
    expect(names).toContain("Read");
    expect([...names].sort()).toEqual(names);
  });
});

describe("requestApproval / decideApproval", () => {
  it("bypasses read-only tools without creating an entry", async () => {
    const { id, outcome } = requestApproval(req({ toolName: "Read" }));
    expect(id).toBeNull();
    await expect(outcome).resolves.toBe("bypassed");
    expect(listPendingApprovals()).toEqual([]);
  });

  it("holds a gated tool pending until decided", async () => {
    const { id, outcome } = requestApproval(req());
    expect(id).not.toBeNull();
    expect(listPendingApprovals().map((p) => p.id)).toEqual([id]);

    expect(decideApproval(id!, "allow")).toBe(true);
    await expect(outcome).resolves.toBe("allow");
    // Resolved entries leave the pending list.
    expect(listPendingApprovals()).toEqual([]);
  });

  it("propagates a deny — the only path that produces one", async () => {
    const { id, outcome } = requestApproval(req());
    decideApproval(id!, "deny");
    await expect(outcome).resolves.toBe("deny");
  });

  describe("replay safety", () => {
    it("rejects a second decision on the same id", async () => {
      const { id, outcome } = requestApproval(req());
      expect(decideApproval(id!, "allow")).toBe(true);
      await outcome;
      // A stale notification tapped later must not land on anything.
      expect(decideApproval(id!, "deny")).toBe(false);
    });

    it("rejects a decision for an id that never existed", () => {
      expect(decideApproval("apr_forged_id", "allow")).toBe(false);
    });

    it("rejects a decision after the request timed out", async () => {
      vi.useFakeTimers();
      const { id, outcome } = requestApproval(req(), 1_000);
      vi.advanceTimersByTime(1_001);
      await expect(outcome).resolves.toBe("timeout");
      expect(decideApproval(id!, "allow")).toBe(false);
    });

    it("issues distinct ids for concurrent requests", () => {
      const a = requestApproval(req());
      const b = requestApproval(req());
      expect(a.id).not.toBe(b.id);
      expect(listPendingApprovals().length).toBe(2);
    });

    it("resolves only the decided request when several are pending", async () => {
      const a = requestApproval(req({ summary: "first" }));
      const b = requestApproval(req({ summary: "second" }));
      decideApproval(a.id!, "allow");
      await expect(a.outcome).resolves.toBe("allow");
      expect(listPendingApprovals().map((p) => p.id)).toEqual([b.id]);
    });
  });

  describe("fail open", () => {
    it("times out to `timeout`, never to a deny", async () => {
      vi.useFakeTimers();
      const { outcome } = requestApproval(req(), 5_000);
      vi.advanceTimersByTime(5_001);
      // The absence of an answer is not a no.
      await expect(outcome).resolves.toBe("timeout");
    });

    it("uses the documented default deadline", async () => {
      vi.useFakeTimers();
      const { outcome } = requestApproval(req());
      vi.advanceTimersByTime(DEFAULT_APPROVAL_TIMEOUT_MS - 1);
      // Still waiting one tick before the deadline.
      let settled = false;
      void outcome.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      vi.advanceTimersByTime(2);
      await expect(outcome).resolves.toBe("timeout");
    });
  });

  describe("bounded lifetime", () => {
    it("sweeps expired entries out of the pending list", () => {
      vi.useFakeTimers();
      const base = 1_000_000;
      requestApproval(req(), 1_000, base);
      expect(listPendingApprovals(base).length).toBe(1);
      // A hook that died mid-request must not leak its entry forever.
      expect(listPendingApprovals(base + 1_001).length).toBe(0);
    });
  });

  describe("allow-all", () => {
    it("auto-allows later calls in the same session", async () => {
      const first = requestApproval(req());
      decideApproval(first.id!, "allow_all");
      await expect(first.outcome).resolves.toBe("allow_all");
      expect(isSessionAutoAllowed("sess-1")).toBe(true);

      const second = requestApproval(req({ summary: "another command" }));
      expect(second.id).toBeNull();
      await expect(second.outcome).resolves.toBe("auto_allow");
    });

    it("is scoped to one session, not global", async () => {
      const first = requestApproval(req({ sessionId: "sess-1" }));
      decideApproval(first.id!, "allow_all");
      await first.outcome;
      // One unattended run must not disarm the gate for every other session.
      const other = requestApproval(req({ sessionId: "sess-2" }));
      expect(other.id).not.toBeNull();
      expect(isSessionAutoAllowed("sess-2")).toBe(false);
    });

    it("can be re-armed", async () => {
      const first = requestApproval(req());
      decideApproval(first.id!, "allow_all");
      await first.outcome;
      expect(clearSessionAutoAllow("sess-1")).toBe(true);
      expect(requestApproval(req()).id).not.toBeNull();
    });

    it("does not set allow-all for a session-less request", async () => {
      const { id, outcome } = requestApproval(req({ sessionId: null }));
      decideApproval(id!, "allow_all");
      await outcome;
      // Nothing to key the exemption on, so nothing is exempted.
      expect(requestApproval(req({ sessionId: null })).id).not.toBeNull();
    });
  });
});

describe("buildHookOutput", () => {
  const decisionOf = (o: Parameters<typeof buildHookOutput>[0]) =>
    buildHookOutput(o).hookSpecificOutput.permissionDecision;

  it("maps approvals to allow", () => {
    expect(decisionOf("allow")).toBe("allow");
    expect(decisionOf("allow_all")).toBe("allow");
    expect(decisionOf("auto_allow")).toBe("allow");
  });

  it("maps an explicit human deny to deny", () => {
    expect(decisionOf("deny")).toBe("deny");
  });

  it("maps a timeout to `ask`, restoring the terminal prompt", () => {
    // The core fail-open assertion: a gate that cannot answer must hand
    // control back rather than decide.
    expect(decisionOf("timeout")).toBe("ask");
  });

  it("maps a bypass to `ask`, not `allow`", () => {
    // Skipping the GATE must not also skip the user's own permission
    // settings — returning `allow` would silently auto-approve reads for
    // someone who had configured Claude Code to ask about them.
    expect(decisionOf("bypassed")).toBe("ask");
  });

  it("always emits the PreToolUse envelope Claude Code parses", () => {
    for (const o of ["allow", "deny", "timeout", "bypassed", "auto_allow", "allow_all"] as const) {
      const out = buildHookOutput(o);
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput.permissionDecisionReason).toBeTruthy();
    }
  });

  it("failOpenHookOutput asks, and carries the reason through", () => {
    const out = failOpenHookOutput("server unreachable");
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("server unreachable");
  });
});

describe("summarizeToolCall", () => {
  it("shows the command verbatim for shell calls", () => {
    expect(summarizeToolCall("Bash", { command: "git push --force" })).toBe(
      "git push --force"
    );
  });

  it("shows path and size for a write, never the content", () => {
    const s = summarizeToolCall("Write", { file_path: "/a/b.ts", content: "x".repeat(50) });
    expect(s).toContain("/a/b.ts");
    expect(s).toContain("50 chars");
    expect(s).not.toContain("xxxx");
  });

  it("clamps long summaries — these reach notification transports", () => {
    const s = summarizeToolCall("Bash", { command: "echo " + "a".repeat(5_000) });
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith("…")).toBe(true);
  });

  it("collapses newlines so a heredoc cannot break a card", () => {
    expect(summarizeToolCall("Bash", { command: "line1\n\nline2" })).toBe("line1 line2");
  });

  it("falls back to the tool name for an unknown shape", () => {
    expect(summarizeToolCall("mcp__x__do", {})).toBe("mcp__x__do");
    expect(summarizeToolCall("Weird", null)).toBe("Weird");
  });

  it("picks a decision-relevant field for unrecognised tools", () => {
    expect(summarizeToolCall("mcp__x__run", { command: "deploy prod" })).toBe(
      "mcp__x__run: deploy prod"
    );
  });
});

describe("buildApprovalCurlCommand", () => {
  it("bounds curl above the server deadline so the server normally answers first", () => {
    const cmd = buildApprovalCurlCommand("http://127.0.0.1:4100/api/hooks/permission", 60_000);
    expect(cmd).toContain("--max-time 63");
  });

  it("uses -f so an HTTP error yields empty stdout, not a parse error", () => {
    // Empty stdout is what Claude Code reads as "no opinion" — this flag
    // is the difference between failing open and feeding it garbage.
    const cmd = buildApprovalCurlCommand("http://x/y", 1_000);
    expect(cmd).toMatch(/(^|\s)-sS -f(\s|$)/);
  });

  it("stays identifiable as Minder-managed for cleanup", () => {
    expect(isManagedCommand(buildApprovalCurlCommand("http://x/y", 1_000))).toBe(true);
  });

  it("never drops below a 1-second ceiling", () => {
    expect(buildApprovalCurlCommand("http://x/y", 0)).toContain("--max-time 3");
  });
});
