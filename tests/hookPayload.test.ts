import { describe, expect, it } from "vitest";
import { parseHookPayload } from "@/lib/hooks/payload";

// Common envelope shared across hook events per the Claude Code hooks doc.
const baseEnvelope = {
  session_id: "abc123",
  transcript_path: "/Users/x/.claude/projects/foo/abc123.jsonl",
  cwd: "/Users/x/repo",
  permission_mode: "default",
};

describe("parseHookPayload — PreToolUse", () => {
  it("returns a PreToolUse variant with toolName + input", () => {
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/p/file.txt", content: "hi" },
        tool_use_id: "toolu_01",
      },
      "PreToolUse",
    );
    expect(p?.kind).toBe("PreToolUse");
    expect(p && p.kind === "PreToolUse" && p.toolName).toBe("Write");
    expect(p && p.kind === "PreToolUse" && p.toolInput).toEqual({
      file_path: "/p/file.txt",
      content: "hi",
    });
    expect(p && p.kind === "PreToolUse" && p.toolUseId).toBe("toolu_01");
    expect(p?.transcriptPath).toBe(baseEnvelope.transcript_path);
    expect(p?.permissionMode).toBe("default");
  });

  it("returns null when tool_name is missing", () => {
    const p = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "PreToolUse" },
      "PreToolUse",
    );
    expect(p).toBeNull();
  });
});

describe("parseHookPayload — PostToolUse", () => {
  it("captures tool_response and duration_ms", () => {
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: { stdout: "file.txt\n", return_code: 0 },
        tool_use_id: "toolu_02",
        duration_ms: 12,
      },
      "PostToolUse",
    );
    expect(p?.kind).toBe("PostToolUse");
    if (p && p.kind === "PostToolUse") {
      expect(p.toolName).toBe("Bash");
      expect(p.toolResponse).toEqual({ stdout: "file.txt\n", return_code: 0 });
      expect(p.durationMs).toBe(12);
      expect(p.toolUseId).toBe("toolu_02");
    }
  });

  it("drops non-finite duration_ms silently", () => {
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        duration_ms: NaN,
      },
      "PostToolUse",
    );
    expect(p && p.kind === "PostToolUse" && p.durationMs).toBeUndefined();
  });
});

describe("parseHookPayload — UserPromptSubmit", () => {
  it("captures the prompt text", () => {
    const p = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "UserPromptSubmit", prompt: "fix the bug" },
      "UserPromptSubmit",
    );
    expect(p?.kind).toBe("UserPromptSubmit");
    expect(p && p.kind === "UserPromptSubmit" && p.prompt).toBe("fix the bug");
  });

  it("treats empty string as valid (not null)", () => {
    // An empty submitted prompt is a real possibility — don't reject.
    const p = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "UserPromptSubmit", prompt: "" },
      "UserPromptSubmit",
    );
    expect(p).not.toBeNull();
    expect(p && p.kind === "UserPromptSubmit" && p.prompt).toBe("");
  });

  it("returns null when prompt is missing entirely", () => {
    const p = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "UserPromptSubmit" },
      "UserPromptSubmit",
    );
    expect(p).toBeNull();
  });
});

describe("parseHookPayload — Notification", () => {
  it("captures matcher + message", () => {
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "Notification",
        matcher: "permission_prompt",
        message: "Claude needs your permission",
      },
      "Notification",
    );
    expect(p?.kind).toBe("Notification");
    if (p && p.kind === "Notification") {
      expect(p.matcher).toBe("permission_prompt");
      expect(p.message).toBe("Claude needs your permission");
    }
  });

  it("falls back to notification_type when matcher is absent", () => {
    // Some Claude Code versions emit `notification_type` instead of
    // `matcher` — accept either so the route doesn't lose the discriminator.
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
      },
      "Notification",
    );
    expect(p && p.kind === "Notification" && p.matcher).toBe("idle_prompt");
  });
});

describe("parseHookPayload — Stop", () => {
  it("captures stop_hook_active + background_tasks + session_crons", () => {
    // The doc snippet exposed at fetch time confirmed Stop + SubagentStop
    // receive both arrays as of Claude Code v2.1.145. Inner element shape
    // isn't published yet, so we preserve verbatim as unknown[].
    const bg = [
      { task_id: "t1", command: "npm run build", status: "running" },
      { task_id: "t2", command: "tail -f log", status: "running" },
    ];
    const crons = [{ schedule: "*/5 * * * *", command: "rebuild-docs" }];
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "Stop",
        stop_hook_active: false,
        background_tasks: bg,
        session_crons: crons,
      },
      "Stop",
    );
    expect(p?.kind).toBe("Stop");
    if (p && p.kind === "Stop") {
      expect(p.stopHookActive).toBe(false);
      expect(p.backgroundTasks).toEqual(bg);
      expect(p.sessionCrons).toEqual(crons);
    }
  });

  it("accepts Stop with no bg/crons fields (pre-v2.1.145)", () => {
    const p = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "Stop", stop_hook_active: true },
      "Stop",
    );
    expect(p?.kind).toBe("Stop");
    if (p && p.kind === "Stop") {
      expect(p.stopHookActive).toBe(true);
      expect(p.backgroundTasks).toBeUndefined();
      expect(p.sessionCrons).toBeUndefined();
    }
  });

  it("drops non-array bg_tasks / session_crons (defensive)", () => {
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "Stop",
        background_tasks: "not an array",
        session_crons: { not: "an array" },
      },
      "Stop",
    );
    expect(p && p.kind === "Stop" && p.backgroundTasks).toBeUndefined();
    expect(p && p.kind === "Stop" && p.sessionCrons).toBeUndefined();
  });
});

describe("parseHookPayload — SubagentStop", () => {
  it("captures agent_id + agent_type + transcript + last_assistant_message + bg/crons", () => {
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "SubagentStop",
        stop_hook_active: false,
        agent_id: "def456",
        agent_type: "Explore",
        agent_transcript_path: "~/.claude/projects/foo/abc123/subagents/agent-def456.jsonl",
        last_assistant_message: "Found 3 issues",
        background_tasks: [],
        session_crons: [],
      },
      "SubagentStop",
    );
    expect(p?.kind).toBe("SubagentStop");
    if (p && p.kind === "SubagentStop") {
      expect(p.agentId).toBe("def456");
      expect(p.agentType).toBe("Explore");
      expect(p.agentTranscriptPath).toContain("agent-def456.jsonl");
      expect(p.lastAssistantMessage).toBe("Found 3 issues");
      expect(p.backgroundTasks).toEqual([]);
    }
  });
});

describe("parseHookPayload — PreCompact", () => {
  it("narrows trigger to 'manual' | 'auto'", () => {
    const manual = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "PreCompact", trigger: "manual", custom_instructions: "keep tests" },
      "PreCompact",
    );
    expect(manual && manual.kind === "PreCompact" && manual.trigger).toBe("manual");
    expect(manual && manual.kind === "PreCompact" && manual.customInstructions).toBe("keep tests");

    const bogus = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "PreCompact", trigger: "weird" },
      "PreCompact",
    );
    // Unknown trigger values drop to undefined so consumers can't read
    // an unvalidated string as a discriminator.
    expect(bogus && bogus.kind === "PreCompact" && bogus.trigger).toBeUndefined();
  });
});

describe("parseHookPayload — SessionStart / SessionEnd", () => {
  it("SessionStart captures source + model + agent_type", () => {
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        hook_event_name: "SessionStart",
        source: "resume",
        model: "claude-sonnet-4-5",
        agent_type: "general-purpose",
      },
      "SessionStart",
    );
    expect(p?.kind).toBe("SessionStart");
    if (p && p.kind === "SessionStart") {
      expect(p.source).toBe("resume");
      expect(p.model).toBe("claude-sonnet-4-5");
      expect(p.agentType).toBe("general-purpose");
    }
  });

  it("SessionEnd captures reason", () => {
    const p = parseHookPayload(
      { ...baseEnvelope, hook_event_name: "SessionEnd", reason: "logout" },
      "SessionEnd",
    );
    expect(p?.kind).toBe("SessionEnd");
    expect(p && p.kind === "SessionEnd" && p.reason).toBe("logout");
  });
});

describe("parseHookPayload — defensive parsing", () => {
  it("ignores type-mismatched string/bool/number fields", () => {
    // permission_mode is documented as string; a bool here should drop
    // to undefined rather than poison the typed payload.
    const p = parseHookPayload(
      {
        ...baseEnvelope,
        permission_mode: true,
        hook_event_name: "Stop",
        stop_hook_active: "no",
      },
      "Stop",
    );
    expect(p?.permissionMode).toBeUndefined();
    expect(p && p.kind === "Stop" && p.stopHookActive).toBeUndefined();
  });
});
