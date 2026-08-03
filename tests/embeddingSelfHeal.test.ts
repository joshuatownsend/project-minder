import { describe, it, expect } from "vitest";
import {
  BLOCKED_COOLDOWN_TICKS,
  ERROR_COOLDOWN_TICKS,
  IDLE_COOLDOWN_TICKS,
  SELF_HEAL_CHUNKS,
  afterPass,
  classifyPass,
  cooldownFor,
  initialSelfHealState,
  shouldRunSelfHeal,
  tickCooldown,
  type SelfHealState,
} from "@/lib/embeddings/selfHeal";

function gate(over: Partial<Parameters<typeof shouldRunSelfHeal>[0]> = {}) {
  return {
    enabled: true,
    stopped: false,
    inFlightTasks: 0,
    state: initialSelfHealState(),
    ...over,
  };
}

describe("shouldRunSelfHeal", () => {
  it("runs on an idle, enabled, cooled-down dispatcher", () => {
    expect(shouldRunSelfHeal(gate())).toBe(true);
  });

  it("does nothing unless enabled", () => {
    expect(shouldRunSelfHeal(gate({ enabled: false }))).toBe(false);
  });

  it("does not start work during shutdown", () => {
    expect(shouldRunSelfHeal(gate({ stopped: true }))).toBe(false);
  });

  // The whole point of "in the gaps": a background nicety must never compete
  // for CPU with the agent tasks the dispatcher exists to run.
  it("stands down while any task is in flight", () => {
    expect(shouldRunSelfHeal(gate({ inFlightTasks: 1 }))).toBe(false);
    expect(shouldRunSelfHeal(gate({ inFlightTasks: 3 }))).toBe(false);
  });

  it("does not overlap itself", () => {
    // The tick does not await the pass, so this flag is the only thing
    // stopping a second pass from starting 30 seconds into the first.
    expect(shouldRunSelfHeal(gate({ state: { cooldownTicks: 0, running: true } }))).toBe(false);
  });

  it("waits out a cooldown", () => {
    expect(shouldRunSelfHeal(gate({ state: { cooldownTicks: 1, running: false } }))).toBe(false);
  });
});

describe("tickCooldown", () => {
  it("counts down one tick at a time", () => {
    let s: SelfHealState = { cooldownTicks: 3, running: false };
    s = tickCooldown(s);
    expect(s.cooldownTicks).toBe(2);
    s = tickCooldown(tickCooldown(s));
    expect(s.cooldownTicks).toBe(0);
  });

  it("never goes negative", () => {
    const s = tickCooldown({ cooldownTicks: 0, running: false });
    expect(s.cooldownTicks).toBe(0);
  });

  it("leaves `running` alone", () => {
    expect(tickCooldown({ cooldownTicks: 2, running: true }).running).toBe(true);
  });

  it("a cooled-down state eventually becomes runnable again", () => {
    let s = afterPass("idle");
    for (let i = 0; i < IDLE_COOLDOWN_TICKS; i++) {
      expect(shouldRunSelfHeal(gate({ state: s }))).toBe(false);
      s = tickCooldown(s);
    }
    expect(shouldRunSelfHeal(gate({ state: s }))).toBe(true);
  });
});

describe("classifyPass", () => {
  it("counts embedded chunks as progress", () => {
    expect(classifyPass({ embedded: 250 })).toBe("progress");
  });

  // No stop code and nothing embedded would otherwise schedule the next pass
  // immediately, spinning at tick rate against a corpus with nothing to do.
  it("treats a silent zero-progress pass as idle, not progress", () => {
    expect(classifyPass({ embedded: 0 })).toBe("idle");
  });

  it("maps the stop codes to their scheduling consequence", () => {
    expect(classifyPass({ embedded: 0, stoppedBecause: "nothing-to-do" })).toBe("idle");
    expect(classifyPass({ embedded: 0, stoppedBecause: "error" })).toBe("error");
    expect(classifyPass({ embedded: 0, stoppedBecause: "no-model" })).toBe("blocked");
    expect(classifyPass({ embedded: 0, stoppedBecause: "no-chunk-corpus" })).toBe("blocked");
  });

  it("honours a stop code even when the pass embedded something first", () => {
    // A pass that failed partway still committed its earlier batches; the
    // failure is what governs when to come back, not the partial success.
    expect(classifyPass({ embedded: 120, stoppedBecause: "error" })).toBe("error");
  });
});

describe("cooldownFor", () => {
  it("comes straight back while there is progress to make", () => {
    expect(cooldownFor("progress")).toBe(0);
  });

  // A missing model or migration needs human action; retrying it on the idle
  // timer would pay a pruneInvalidVectors sweep every ten minutes forever.
  it("backs off further the less likely the condition is to clear itself", () => {
    expect(cooldownFor("idle")).toBe(IDLE_COOLDOWN_TICKS);
    expect(cooldownFor("error")).toBe(ERROR_COOLDOWN_TICKS);
    expect(cooldownFor("blocked")).toBe(BLOCKED_COOLDOWN_TICKS);
    expect(cooldownFor("idle")).toBeLessThan(cooldownFor("error"));
    expect(cooldownFor("error")).toBeLessThan(cooldownFor("blocked"));
  });
});

describe("afterPass", () => {
  it("always clears `running`", () => {
    // A stuck `running` disables self-heal for the life of the process,
    // silently — so every outcome, including failure, must release it.
    for (const outcome of ["progress", "idle", "error", "blocked"] as const) {
      expect(afterPass(outcome).running).toBe(false);
    }
  });

  it("lets consecutive productive passes run back to back", () => {
    const s = afterPass("progress");
    expect(shouldRunSelfHeal(gate({ state: s }))).toBe(true);
  });
});

describe("budget", () => {
  it("is sized for drift rather than bulk", () => {
    // ~3.8 s at the measured 15.3 ms/chunk against a 30 s tick. If this grows
    // past a few seconds it stops being something that runs unattended.
    expect(SELF_HEAL_CHUNKS * 15.3).toBeLessThan(6_000);
    expect(SELF_HEAL_CHUNKS).toBeGreaterThan(0);
  });
});

describe("initialSelfHealState", () => {
  it("starts runnable", () => {
    expect(initialSelfHealState()).toEqual({ cooldownTicks: 0, running: false });
    expect(shouldRunSelfHeal(gate({ state: initialSelfHealState() }))).toBe(true);
  });
});
