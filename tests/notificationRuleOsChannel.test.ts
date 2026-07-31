import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  queueOsNotification,
  drainOsNotifications,
  pendingOsCount,
  resetOsQueue,
  type PendingOsNotification,
} from "@/lib/notifications/rules/osQueue";
import { resetCooldowns } from "@/lib/notifications/rules/cooldown";
import type { MinderConfig } from "@/lib/types";
import type { HookEvent } from "@/lib/hooks/buffer";

vi.mock("@/lib/push/sender", () => ({ sendPushAll: vi.fn(async () => 0) }));
vi.mock("@/lib/notifications/telegram", () => ({ sendTelegram: vi.fn(async () => {}) }));

function entry(over: Partial<PendingOsNotification> = {}): PendingOsNotification {
  return {
    ruleId: "r1",
    ruleName: "Secret access",
    severity: "critical",
    projectSlug: "app",
    projectName: "App",
    excerpt: "file_path .env",
    at: "2026-07-31T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  resetOsQueue();
  resetCooldowns();
});

describe("os notification queue", () => {
  it("drains what was queued, in order", () => {
    queueOsNotification(entry({ ruleId: "a" }));
    queueOsNotification(entry({ ruleId: "b" }));
    expect(drainOsNotifications().map((e) => e.ruleId)).toEqual(["a", "b"]);
  });

  it("is edge-triggered — a second drain returns nothing", () => {
    queueOsNotification(entry());
    expect(drainOsNotifications()).toHaveLength(1);
    expect(drainOsNotifications()).toHaveLength(0);
  });

  it("drops the oldest entries past the cap rather than growing unbounded", () => {
    // No browser open to drain means nothing consumes the queue; a rule on a
    // hot tool must not be able to grow it without limit.
    for (let i = 0; i < 200; i++) queueOsNotification(entry({ ruleId: `r${i}` }));
    const drained = drainOsNotifications();
    expect(drained).toHaveLength(50);
    // Newest kept — a stale alert is worth less than a current one.
    expect(drained[drained.length - 1].ruleId).toBe("r199");
  });

  it("reports a pending count without consuming", () => {
    queueOsNotification(entry());
    expect(pendingOsCount()).toBe(1);
    expect(pendingOsCount()).toBe(1);
    expect(drainOsNotifications()).toHaveLength(1);
  });
});

describe("engine → os channel", () => {
  function config(channels: Record<string, boolean>): MinderConfig {
    return {
      notificationRules: [
        {
          id: "env-rule",
          name: "Secret file accessed",
          enabled: true,
          field: "tool.input",
          op: "contains",
          pattern: ".env",
          channels,
          severity: "critical",
          cooldownSec: 0,
        },
      ],
    } as unknown as MinderConfig;
  }

  const event: HookEvent = {
    hookEventName: "PreToolUse",
    sessionId: "s",
    cwd: "C:\\dev\\app",
    receivedAt: 0,
    toolName: "Read",
    payload: { kind: "PreToolUse", toolName: "Read", toolInput: { file_path: ".env" } },
  };

  it("queues a match for a rule whose only channel is os", async () => {
    // This is the default for a new custom rule and the only channel on two
    // presets — before the queue existed these rules silently did nothing.
    const { evaluateAndDispatchRules } = await import("@/lib/notifications/rules/engine");
    await evaluateAndDispatchRules(config({ os: true }), event, "app", "App");

    const drained = drainOsNotifications();
    expect(drained).toHaveLength(1);
    expect(drained[0].ruleName).toBe("Secret file accessed");
    expect(drained[0].projectSlug).toBe("app");
    expect(drained[0].severity).toBe("critical");
    expect(drained[0].excerpt).toContain(".env");
  });

  it("queues nothing when os is off", async () => {
    const { evaluateAndDispatchRules } = await import("@/lib/notifications/rules/engine");
    await evaluateAndDispatchRules(config({ push: true }), event, "app", "App");
    expect(pendingOsCount()).toBe(0);
  });

  it("queues nothing when the rule does not match", async () => {
    const { evaluateAndDispatchRules } = await import("@/lib/notifications/rules/engine");
    const miss: HookEvent = {
      ...event,
      payload: { kind: "PreToolUse", toolName: "Read", toolInput: { file_path: "src/app.ts" } },
    };
    await evaluateAndDispatchRules(config({ os: true }), miss, "app", "App");
    expect(pendingOsCount()).toBe(0);
  });

  it("respects the cooldown — a second match inside the window is not queued", async () => {
    const { evaluateAndDispatchRules } = await import("@/lib/notifications/rules/engine");
    const cfg = config({ os: true });
    cfg.notificationRules![0].cooldownSec = 600;
    await evaluateAndDispatchRules(cfg, event, "app", "App");
    await evaluateAndDispatchRules(cfg, event, "app", "App");
    expect(pendingOsCount()).toBe(1);
  });
});
