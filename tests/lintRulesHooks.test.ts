import { describe, it, expect } from "vitest";
import { runHookRules } from "@/lib/lint/rules/hooks";
import type { HookEntry } from "@/lib/types";

function makeEntry(
  event: string,
  commands: Array<{ command: string; timeout?: number }>,
  opts: Partial<Pick<HookEntry, "source" | "sourcePath" | "matcher">> = {},
): HookEntry {
  return {
    event,
    commands: commands.map((c) => ({ type: "command", ...c })),
    source: opts.source ?? "project",
    sourcePath: opts.sourcePath ?? ".claude/settings.json",
    matcher: opts.matcher,
  };
}

describe("hook/no-timeout", () => {
  it("returns no findings when all commands have timeouts", () => {
    const entries = [makeEntry("PreToolUse", [{ command: "lint", timeout: 5000 }])];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/no-timeout");
    expect(findings).toHaveLength(0);
  });

  it("flags a hook entry that has at least one command without timeout", () => {
    const entries = [makeEntry("PostToolUse", [{ command: "notify" }])];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/no-timeout");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P2");
    expect(findings[0].engine).toBe("vendored");
  });

  it("emits one finding per hook entry, not one per command", () => {
    const entries = [
      makeEntry("PreToolUse", [
        { command: "cmd-a" },
        { command: "cmd-b" },
        { command: "cmd-c" },
      ]),
    ];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/no-timeout");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("3 commands");
  });

  it("counts untimed commands correctly in the title", () => {
    const entries = [
      makeEntry("Stop", [
        { command: "cmd-a", timeout: 3000 },
        { command: "cmd-b" },
      ]),
    ];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/no-timeout");
    expect(findings[0].title).toContain("1 command");
  });

  it("includes matcher in the finding title when present", () => {
    const entries = [makeEntry("PreToolUse", [{ command: "check" }], { matcher: "Edit" })];
    const [f] = runHookRules(entries).filter((f) => f.code === "hook/no-timeout");
    expect(f.title).toContain("PreToolUse(Edit)");
  });

  it("sets file to sourcePath", () => {
    const entries = [makeEntry("Stop", [{ command: "x" }], { sourcePath: "/proj/.claude/settings.json" })];
    const [f] = runHookRules(entries).filter((f) => f.code === "hook/no-timeout");
    expect(f.file).toBe("/proj/.claude/settings.json");
  });
});

describe("hook/duplicate-event-handler", () => {
  it("returns no findings for unique event registrations", () => {
    const entries = [
      makeEntry("PreToolUse", [{ command: "a", timeout: 1000 }]),
      makeEntry("PostToolUse", [{ command: "b", timeout: 1000 }]),
    ];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/duplicate-event-handler");
    expect(findings).toHaveLength(0);
  });

  it("flags duplicate event + source + sourcePath registrations", () => {
    const entries = [
      makeEntry("PreToolUse", [{ command: "a", timeout: 1000 }]),
      makeEntry("PreToolUse", [{ command: "b", timeout: 1000 }]),
    ];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/duplicate-event-handler");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P2");
  });

  it("does not flag same event from different sources", () => {
    const entries = [
      makeEntry("Stop", [{ command: "a" }], { source: "project" }),
      makeEntry("Stop", [{ command: "b" }], { source: "user" }),
    ];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/duplicate-event-handler");
    expect(findings).toHaveLength(0);
  });

  it("treats same event with different matchers as distinct", () => {
    const entries = [
      makeEntry("PreToolUse", [{ command: "a" }], { matcher: "Edit" }),
      makeEntry("PreToolUse", [{ command: "b" }], { matcher: "Bash" }),
    ];
    const findings = runHookRules(entries).filter((f) => f.code === "hook/duplicate-event-handler");
    expect(findings).toHaveLength(0);
  });
});
