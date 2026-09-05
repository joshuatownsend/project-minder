import { describe, it, expect } from "vitest";
import { createSingleFlight } from "@/lib/singleFlight";

describe("createSingleFlight (#563)", () => {
  it("shares one in-flight run for concurrent calls with the same key", async () => {
    const sf = createSingleFlight<number>();
    let calls = 0;
    const fn = () =>
      new Promise<number>((r) => {
        calls++;
        setTimeout(() => r(calls), 10);
      });

    const [a, b, c] = await Promise.all([sf.run("k", fn), sf.run("k", fn), sf.run("k", fn)]);
    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(sf.size()).toBe(0); // cleared after settle
  });

  it("runs distinct keys independently", async () => {
    const sf = createSingleFlight<string>();
    let n = 0;
    const fn = (v: string) => async () => {
      n++;
      return v;
    };
    const [a, b] = await Promise.all([sf.run("a", fn("a")), sf.run("b", fn("b"))]);
    expect(n).toBe(2);
    expect([a, b]).toEqual(["a", "b"]);
  });

  it("clears a rejected key so a later call re-runs, and propagates the error", async () => {
    const sf = createSingleFlight<number>();
    await expect(
      sf.run("k", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(sf.size()).toBe(0);

    // A fresh call for the same key runs again rather than reusing the failure.
    await expect(sf.run("k", async () => 42)).resolves.toBe(42);
  });

  it("a second call arriving after the first settled runs fresh", async () => {
    const sf = createSingleFlight<number>();
    let calls = 0;
    const fn = async () => ++calls;
    expect(await sf.run("k", fn)).toBe(1);
    expect(await sf.run("k", fn)).toBe(2);
  });
});
