import { describe, it, expect } from "vitest";
import { extractFields } from "@/lib/notifications/rules/fields";
import { MAX_ANY_LENGTH, MAX_FIELD_LENGTH } from "@/lib/notifications/rules/types";
import type { HookEvent } from "@/lib/hooks/buffer";

function preToolUse(toolName: string, toolInput: unknown, extra: Partial<HookEvent> = {}): HookEvent {
  return {
    hookEventName: "PreToolUse",
    sessionId: "s1",
    cwd: "C:\\dev\\project-minder",
    receivedAt: 0,
    toolName,
    payload: { kind: "PreToolUse", toolName, toolInput },
    ...extra,
  };
}

describe("extractFields — envelope", () => {
  it("always provides event, project and cwd", () => {
    const f = extractFields(preToolUse("Read", { file_path: "a.ts" }), "project-minder");
    expect(f.event).toBe("PreToolUse");
    expect(f.project).toBe("project-minder");
    expect(f.cwd).toBe("C:\\dev\\project-minder");
  });

  it("omits fields the event does not carry, so they can never match", () => {
    const f = extractFields(preToolUse("Read", { file_path: "a.ts" }), "p");
    expect(f.prompt).toBeUndefined();
    expect(f["tool.response"]).toBeUndefined();
    expect(f["tool.durationMs"]).toBeUndefined();
    expect(f.model).toBeUndefined();
  });
});

describe("extractFields — tool.input", () => {
  it("finds a path nested in the tool input (the .env case)", () => {
    const f = extractFields(preToolUse("Read", { file_path: "C:\\dev\\app\\.env.local" }), "app");
    expect(f["tool.input"]).toContain(".env.local");
  });

  it("includes keys as well as values, so a rule can match a field name", () => {
    const f = extractFields(preToolUse("Bash", { command: "ls", description: "list" }), "p");
    expect(f["tool.input"]).toContain("command");
    expect(f["tool.input"]).toContain("description");
  });

  it("keeps a short sibling field visible next to a huge one", () => {
    // This is the whole reason leaves are capped individually. An Edit carries
    // a multi-KB new_string beside the file_path that actually matters; a
    // total-only cap would truncate the path away and the rule would miss.
    const f = extractFields(
      preToolUse("Edit", {
        new_string: "x".repeat(50_000),
        old_string: "y".repeat(50_000),
        file_path: "C:\\dev\\app\\.env",
      }),
      "app",
    );
    expect(f["tool.input"]).toContain(".env");
    expect(String(f["tool.input"]).length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
  });

  it("descends into MultiEdit's edits array", () => {
    const f = extractFields(
      preToolUse("MultiEdit", {
        file_path: "a.ts",
        edits: [{ old_string: "SECRET_TOKEN", new_string: "redacted" }],
      }),
      "p",
    );
    expect(f["tool.input"]).toContain("SECRET_TOKEN");
  });

  it("survives a deeply nested / self-referential-shaped object without hanging", () => {
    const deep: Record<string, unknown> = { level: "a" };
    let cursor = deep;
    for (let i = 0; i < 500; i++) {
      const next: Record<string, unknown> = { level: `d${i}` };
      cursor.child = next;
      cursor = next;
    }
    const f = extractFields(preToolUse("Weird", deep), "p");
    expect(typeof f["tool.input"]).toBe("string");
  });

  it("returns undefined rather than an empty string for an absent input", () => {
    const f = extractFields(preToolUse("Read", undefined), "p");
    expect(f["tool.input"]).toBeUndefined();
  });
});

describe("extractFields — per-event payloads", () => {
  it("captures prompt on UserPromptSubmit", () => {
    const f = extractFields(
      {
        hookEventName: "UserPromptSubmit",
        sessionId: "s",
        cwd: "C:\\dev\\p",
        receivedAt: 0,
        payload: { kind: "UserPromptSubmit", prompt: "deploy to prod" },
      },
      "p",
    );
    expect(f.prompt).toBe("deploy to prod");
  });

  it("captures durationMs and response on PostToolUse", () => {
    const f = extractFields(
      {
        hookEventName: "PostToolUse",
        sessionId: "s",
        cwd: "C:\\dev\\p",
        receivedAt: 0,
        toolName: "Bash",
        toolFailed: true,
        payload: {
          kind: "PostToolUse",
          toolName: "Bash",
          toolResponse: { is_error: true, stderr: "permission denied" },
          durationMs: 91_000,
        },
      },
      "p",
    );
    expect(f["tool.durationMs"]).toBe(91_000);
    expect(f["tool.failed"]).toBe("true");
    expect(f["tool.response"]).toContain("permission denied");
  });

  it("reports tool.failed as \"false\" on a successful PostToolUse", () => {
    // The route leaves `toolFailed` undefined on success. Since absent fields
    // never match, omitting it would make `tool.failed equals false`
    // unsatisfiable while the editor and help both offer it.
    const f = extractFields(
      {
        hookEventName: "PostToolUse",
        sessionId: "s",
        cwd: "C:\\dev\\p",
        receivedAt: 0,
        toolName: "Bash",
        payload: { kind: "PostToolUse", toolName: "Bash" },
      },
      "p",
    );
    expect(f["tool.failed"]).toBe("false");
  });

  it("still omits tool.failed on PreToolUse, where success is not yet known", () => {
    const f = extractFields(preToolUse("Bash", { command: "ls" }), "p");
    expect(f["tool.failed"]).toBeUndefined();
  });

  it("captures permissionMode — the bypass-detection field", () => {
    const f = extractFields(
      {
        hookEventName: "PreToolUse",
        sessionId: "s",
        cwd: "C:\\dev\\p",
        receivedAt: 0,
        toolName: "Bash",
        payload: {
          kind: "PreToolUse",
          toolName: "Bash",
          permissionMode: "bypassPermissions",
        },
      },
      "p",
    );
    expect(f.permissionMode).toBe("bypassPermissions");
  });

  it("captures model on SessionStart and agentType on SubagentStop", () => {
    const start = extractFields(
      {
        hookEventName: "SessionStart",
        sessionId: "s",
        cwd: "C:\\dev\\p",
        receivedAt: 0,
        payload: { kind: "SessionStart", model: "claude-opus-5" },
      },
      "p",
    );
    expect(start.model).toBe("claude-opus-5");

    const stop = extractFields(
      {
        hookEventName: "SubagentStop",
        sessionId: "s",
        cwd: "C:\\dev\\p",
        receivedAt: 0,
        payload: { kind: "SubagentStop", agentType: "Explore" },
      },
      "p",
    );
    expect(stop.agentType).toBe("Explore");
  });

  it("tolerates a null payload (parse failure) without losing envelope fields", () => {
    const f = extractFields(
      {
        hookEventName: "PreToolUse",
        sessionId: "s",
        cwd: "C:\\dev\\p",
        receivedAt: 0,
        toolName: "Bash",
        payload: null,
      },
      "p",
    );
    expect(f["tool.name"]).toBe("Bash");
    expect(f["tool.input"]).toBeUndefined();
  });
});

describe("extractFields — the `any` field", () => {
  it("concatenates the other fields", () => {
    const f = extractFields(preToolUse("Bash", { command: "cat .env" }), "app");
    expect(f.any).toContain("Bash");
    expect(f.any).toContain(".env");
  });

  it("stays within its cap even when several fields are at theirs", () => {
    const f = extractFields(
      {
        hookEventName: "PostToolUse",
        sessionId: "s",
        cwd: "C:\\dev\\" + "d".repeat(5_000),
        receivedAt: 0,
        toolName: "Bash",
        payload: {
          kind: "PostToolUse",
          toolName: "Bash",
          toolInput: { command: "x".repeat(9_000) },
          toolResponse: { stdout: "y".repeat(9_000) },
        },
      },
      "p",
    );
    expect(String(f.any).length).toBeLessThanOrEqual(MAX_ANY_LENGTH);
  });
});
