import { describe, it, expect } from "vitest";
import { RULE_PRESETS, instantiatePreset } from "@/lib/notifications/rules/presets";
import { extractFields } from "@/lib/notifications/rules/fields";
import { matchRule } from "@/lib/notifications/rules/matcher";
import type { NotificationRule } from "@/lib/notifications/rules/types";
import type { HookEvent } from "@/lib/hooks/buffer";

function preset(id: string): NotificationRule {
  const p = RULE_PRESETS.find((x) => x.rule.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  // Presets ship some rules disabled; enable so the match logic is what's tested.
  return { ...instantiatePreset(p), enabled: true };
}

/** Does `rule` fire on `event`? Runs the real extract → match pipeline. */
function fires(rule: NotificationRule, event: HookEvent, slug = "app"): boolean {
  return matchRule(rule, extractFields(event, slug), slug) !== null;
}

function toolEvent(
  kind: "PreToolUse" | "PostToolUse",
  toolName: string,
  toolInput: unknown,
  extra: Partial<HookEvent> = {},
): HookEvent {
  return {
    hookEventName: kind,
    sessionId: "s",
    cwd: "C:\\dev\\app",
    receivedAt: 0,
    toolName,
    payload: { kind, toolName, toolInput } as HookEvent["payload"],
    ...extra,
  };
}

describe("preset: Secret file accessed", () => {
  const rule = preset("preset-env-access");

  it("fires on a Read of .env", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Read", { file_path: "C:\\dev\\app\\.env" }))).toBe(true);
  });

  it("fires on .env.local and .env.production", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Read", { file_path: "app/.env.local" }))).toBe(true);
    expect(fires(rule, toolEvent("PreToolUse", "Read", { file_path: "app/.env.production" }))).toBe(true);
  });

  it("fires on a shell command that cats .env", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Bash", { command: "cat .env | grep KEY" }))).toBe(true);
  });

  it("fires when .env is buried behind a large edit body", () => {
    expect(
      fires(
        rule,
        toolEvent("PreToolUse", "Edit", {
          new_string: "z".repeat(30_000),
          file_path: ".env",
        }),
      ),
    ).toBe(true);
  });

  it("does not fire on an ordinary source file", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Read", { file_path: "src/lib/config.ts" }))).toBe(false);
  });

  it("does not fire on a non-tool event", () => {
    expect(
      fires(rule, {
        hookEventName: "UserPromptSubmit",
        sessionId: "s",
        cwd: "C:\\dev\\app",
        receivedAt: 0,
        payload: { kind: "UserPromptSubmit", prompt: "check the .env file" },
      }),
    ).toBe(false);
  });
});

describe("preset: Running with permissions bypassed", () => {
  const rule = preset("preset-permission-bypass");

  it("fires when the session reports bypassPermissions", () => {
    const event = toolEvent("PreToolUse", "Bash", { command: "ls" });
    event.payload = { kind: "PreToolUse", toolName: "Bash", permissionMode: "bypassPermissions" };
    expect(fires(rule, event)).toBe(true);
  });

  it("does not fire in default or acceptEdits mode", () => {
    for (const mode of ["default", "acceptEdits", "plan"]) {
      const event = toolEvent("PreToolUse", "Bash", { command: "ls" });
      event.payload = { kind: "PreToolUse", toolName: "Bash", permissionMode: mode };
      expect(fires(rule, event)).toBe(false);
    }
  });
});

describe("preset: Tool call failed", () => {
  const rule = preset("preset-tool-error");

  it("fires on a PostToolUse carrying the failure flag", () => {
    expect(
      fires(rule, toolEvent("PostToolUse", "Bash", { command: "pnpm test" }, { toolFailed: true })),
    ).toBe(true);
  });

  it("does not fire on a successful call", () => {
    expect(
      fires(rule, toolEvent("PostToolUse", "Bash", { command: "pnpm test" }, { toolFailed: undefined })),
    ).toBe(false);
  });

  it("does not fire on PreToolUse, where success is not yet known", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Bash", { command: "pnpm test" }))).toBe(false);
  });
});

describe("preset: Destructive shell command", () => {
  const rule = preset("preset-destructive-shell");

  it("fires on rm -rf", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Bash", { command: "rm -rf .next/standalone" }))).toBe(true);
  });

  it("does not fire on a plain rm", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Bash", { command: "rm ./tmp.log" }))).toBe(false);
  });
});

describe("preset: Force push", () => {
  const rule = preset("preset-force-push");

  it("fires on git push --force", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Bash", { command: "git push --force origin main" }))).toBe(true);
  });

  it("also fires on --force-with-lease, which shares the prefix", () => {
    // Documented consequence of matching a literal: the safe form contains the
    // unsafe form as a prefix. Recorded as a test so the behaviour is a known
    // trade-off rather than a surprise.
    expect(fires(rule, toolEvent("PreToolUse", "Bash", { command: "git push --force-with-lease" }))).toBe(true);
  });

  it("does not fire on an ordinary push", () => {
    expect(fires(rule, toolEvent("PreToolUse", "Bash", { command: "git push origin main" }))).toBe(false);
  });
});

describe("preset: Tool call took over a minute", () => {
  const rule = preset("preset-slow-tool");

  it("fires above the threshold and not below", () => {
    const slow = toolEvent("PostToolUse", "Bash", { command: "pnpm build" });
    slow.payload = { kind: "PostToolUse", toolName: "Bash", durationMs: 300_000 };
    expect(fires(rule, slow)).toBe(true);

    const fast = toolEvent("PostToolUse", "Bash", { command: "pnpm typecheck" });
    fast.payload = { kind: "PostToolUse", toolName: "Bash", durationMs: 8_000 };
    expect(fires(rule, fast)).toBe(false);
  });

  it("ships disabled — a 5-minute build is normal here, not news", () => {
    const shipped = RULE_PRESETS.find((p) => p.rule.id === "preset-slow-tool")!;
    expect(shipped.rule.enabled).toBe(false);
  });
});

describe("preset hygiene", () => {
  it("has unique ids", () => {
    const ids = RULE_PRESETS.map((p) => p.rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses no regex operator — presets stay safe by construction", () => {
    expect(RULE_PRESETS.every((p) => p.rule.op !== "regex")).toBe(true);
  });

  it("every preset names at least one channel, or it could never notify", () => {
    for (const p of RULE_PRESETS) {
      expect(Object.values(p.rule.channels).some(Boolean)).toBe(true);
    }
  });

  it("instantiatePreset deep-copies, so editing a rule cannot mutate the module", () => {
    const a = instantiatePreset(RULE_PRESETS[0]);
    a.channels.push = !a.channels.push;
    a.events?.push("Stop");
    const b = instantiatePreset(RULE_PRESETS[0]);
    expect(b.channels).toEqual(RULE_PRESETS[0].rule.channels);
    expect(b.events).toEqual(RULE_PRESETS[0].rule.events);
  });
});
