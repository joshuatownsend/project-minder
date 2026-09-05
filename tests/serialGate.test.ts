import { describe, it, expect } from "vitest";
import { createSerialGate } from "@/lib/serialGate";

describe("createSerialGate (#563)", () => {
  it("runs tasks one at a time, in call order, never overlapping", async () => {
    const gate = createSerialGate();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (id: string, ms: number) =>
      gate.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`enter:${id}`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`exit:${id}`);
        active--;
        return id;
      });

    // Fire three at once; a later, faster one must still wait its turn.
    const results = await Promise.all([task("a", 30), task("b", 5), task("c", 5)]);

    expect(maxActive).toBe(1);
    expect(events).toEqual(["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("a rejected task does not wedge the queue and still rejects its own caller", async () => {
    const gate = createSerialGate();
    const boom = gate.run(async () => {
      throw new Error("boom");
    });
    const after = gate.run(async () => "ok");

    await expect(boom).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });

  it("propagates each task's own result to its own caller", async () => {
    const gate = createSerialGate();
    const [a, b] = await Promise.all([gate.run(async () => 1), gate.run(async () => 2)]);
    expect([a, b]).toEqual([1, 2]);
  });
});
