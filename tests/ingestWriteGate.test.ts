import { describe, it, expect } from "vitest";
import { createWriteGate, WRITE_GATE_SLACK_MS, type JudgedOutcome } from "@/lib/db/nativeWatch";

// #606 — the write gate behind the recursive watch, driven by an injected `stat`
// and clock. `ingestNativeWatch.test.ts` exercises the same decisions through the
// real filesystem, but those tests can only wait for an event the OS delivers when
// it chooses to: a late callback is discarded by teardown and a "nothing was
// forwarded" assertion passes without ever having been tested. Nothing here
// depends on the OS, so every ruling is observed by construction.

const T0 = 1_700_000_000_000; // arming time (epoch ms)
const WRITTEN = T0 + 1_000; // an mtime from after arming: a real write
const STALE = T0 - 60 * 60 * 1000; // written an hour before arming: an access-time bump

type Sig = { size: number; mtimeMs: number };

/** A gate over a scripted filesystem. `files` is mutated by the test between events. */
function harness(options: { maxRemembered?: number; now?: () => number; monotonic?: () => number } = {}) {
  const files = new Map<string, Sig | Error>();
  const changed: string[] = [];
  const judged: { file: string; outcome: JudgedOutcome }[] = [];
  const clock = { now: options.now ?? (() => T0), monotonic: options.monotonic ?? (() => 0) };
  const gate = createWriteGate({
    stat: async (f) => {
      const v = files.get(f);
      if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (v instanceof Error) throw v;
      return v;
    },
    onChange: (f) => changed.push(f),
    onJudged: (file, outcome) => judged.push({ file, outcome }),
    clock,
    maxRemembered: options.maxRemembered,
  });
  /** Deliver one `change` and wait for the gate's ruling on it. */
  const event = async (f: string) => {
    gate.judge(f);
    await gate.settled();
    return judged[judged.length - 1];
  };
  const count = (f: string) => changed.filter((c) => c === f).length;
  return { files, changed, judged, gate, event, count, clock };
}

describe("write gate (#606)", () => {
  it("drops a change to a file last written before the watch armed (access-time bump)", async () => {
    const h = harness();
    h.files.set("a", { size: 10, mtimeMs: STALE });
    expect(await h.event("a")).toEqual({ file: "a", outcome: "old" });
    expect(h.changed).toEqual([]);
  });

  it("forwards a change whose mtime is after arming", async () => {
    const h = harness();
    h.files.set("a", { size: 10, mtimeMs: WRITTEN });
    expect(await h.event("a")).toEqual({ file: "a", outcome: "forwarded" });
    expect(h.changed).toEqual(["a"]);
  });

  it("lets a write inside the slack window through, and rejects one just outside it", async () => {
    const h = harness();
    h.files.set("in", { size: 1, mtimeMs: T0 - WRITE_GATE_SLACK_MS });
    h.files.set("out", { size: 1, mtimeMs: T0 - WRITE_GATE_SLACK_MS - 1 });
    expect((await h.event("in")).outcome).toBe("forwarded");
    expect((await h.event("out")).outcome).toBe("old");
  });

  describe("a read that follows a write it already forwarded", () => {
    it("is not forwarded again", async () => {
      const h = harness();
      h.files.set("a", { size: 10, mtimeMs: WRITTEN });
      await h.event("a");
      // The read bumps atime only: same size, same mtime.
      expect((await h.event("a")).outcome).toBe("duplicate");
      expect(h.count("a")).toBe(1);
    });

    it("tolerates a millisecond of timestamp rounding", async () => {
      const h = harness();
      h.files.set("a", { size: 10, mtimeMs: WRITTEN });
      await h.event("a");
      h.files.set("a", { size: 10, mtimeMs: WRITTEN + 1 });
      expect((await h.event("a")).outcome).toBe("duplicate");
    });

    it("is forwarded when the size changed (a real append)", async () => {
      const h = harness();
      h.files.set("a", { size: 10, mtimeMs: WRITTEN });
      await h.event("a");
      h.files.set("a", { size: 14, mtimeMs: WRITTEN });
      expect((await h.event("a")).outcome).toBe("forwarded");
      expect(h.count("a")).toBe(2);
    });

    it("is forwarded when the mtime moved on at the same size", async () => {
      const h = harness();
      h.files.set("a", { size: 10, mtimeMs: WRITTEN });
      await h.event("a");
      h.files.set("a", { size: 10, mtimeMs: WRITTEN + 50 });
      expect((await h.event("a")).outcome).toBe("forwarded");
    });
  });

  describe("at the remembered-signature cap", () => {
    it("evicts the oldest write, not everything", async () => {
      const h = harness({ maxRemembered: 3 });
      for (const f of ["f1", "f2", "f3", "f4"]) {
        h.files.set(f, { size: 5, mtimeMs: WRITTEN });
        await h.event(f); // four real writes: the fourth evicts f1 only
      }
      const before = (f: string) => h.count(f);
      const f3 = before("f3");
      const f1 = before("f1");
      // A history-wide read now touches each file again, signatures unchanged.
      // f3 is a MIDDLE entry: a wipe-everything eviction would forget it as well.
      expect((await h.event("f3")).outcome).toBe("duplicate");
      expect(h.count("f3")).toBe(f3);
      expect((await h.event("f4")).outcome).toBe("duplicate");
      // f1, the oldest, was evicted, so its read looks like a new write.
      expect((await h.event("f1")).outcome).toBe("forwarded");
      expect(h.count("f1")).toBe(f1 + 1);
    });

    it("keeps recency order: re-writing a file protects it from the next eviction", async () => {
      // Cap 4, one eviction at a time. Sizes stay below the cap until f5, so the
      // only thing that can decide WHO is evicted is where f1 sits in the order.
      const h = harness({ maxRemembered: 4 });
      for (const f of ["f1", "f2", "f3"]) {
        h.files.set(f, { size: 5, mtimeMs: WRITTEN });
        await h.event(f);
      }
      // f1 is written again, so it is now the NEWEST of the three; f2 is the oldest.
      h.files.set("f1", { size: 6, mtimeMs: WRITTEN });
      await h.event("f1");
      for (const f of ["f4", "f5"]) {
        h.files.set(f, { size: 5, mtimeMs: WRITTEN });
        await h.event(f); // f5 arrives at the cap and evicts exactly one: f2
      }
      expect((await h.event("f1")).outcome).toBe("duplicate"); // protected by the re-write
      expect((await h.event("f2")).outcome).toBe("forwarded"); // the oldest, evicted
    });
  });

  describe("a wall clock that is set back after arming", () => {
    it("still forwards genuine writes whose mtimes are below the arming time", async () => {
      // Arms with the clock two minutes ahead, then it is corrected: real writes
      // now get mtimes ~2 minutes below `armedAt`, far past the slack window.
      let wall = T0 + 120_000;
      let mono = 0;
      const h = harness({ now: () => wall, monotonic: () => mono });
      wall = T0; // corrected back; no monotonic time has passed
      h.files.set("a", { size: 3, mtimeMs: T0 + 100 });
      expect((await h.event("a")).outcome).toBe("forwarded");
    });

    it("still rejects an access-time bump after the same correction", async () => {
      let wall = T0 + 120_000;
      const h = harness({ now: () => wall });
      wall = T0;
      h.files.set("a", { size: 3, mtimeMs: STALE });
      expect((await h.event("a")).outcome).toBe("old");
    });

    it("does not raise the threshold when the clock jumps forward (suspend/resume)", async () => {
      let wall = T0;
      let mono = 0;
      const h = harness({ now: () => wall, monotonic: () => mono });
      wall = T0 + 3_600_000; // an hour passes on the wall clock with no monotonic time
      h.files.set("a", { size: 3, mtimeMs: T0 + 10 }); // written shortly after arming
      expect((await h.event("a")).outcome).toBe("forwarded");
    });
  });

  it("fails open when the file cannot be stat'ed", async () => {
    const h = harness();
    h.files.set("a", Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    expect(await h.event("a")).toEqual({ file: "a", outcome: "unreadable" });
    expect(h.changed).toEqual(["a"]);
  });

  it("forget() drops the remembered signature, so the next change is judged afresh", async () => {
    const h = harness();
    h.files.set("a", { size: 10, mtimeMs: WRITTEN });
    await h.event("a");
    h.gate.forget("a"); // the file was deleted and recreated with the same signature
    expect((await h.event("a")).outcome).toBe("forwarded");
    expect(h.count("a")).toBe(2);
  });

  describe("a ruling that is still in flight", () => {
    /** A stat the test resolves by hand, to place the OS callback exactly. */
    function deferredGate() {
      let release!: (s: Sig) => void;
      let fail!: (e: Error) => void;
      const changed: string[] = [];
      const judged: string[] = [];
      const gate = createWriteGate({
        stat: () =>
          new Promise<Sig>((res, rej) => {
            release = res;
            fail = rej;
          }),
        onChange: (f) => changed.push(f),
        onJudged: (f, o) => judged.push(`${f}:${o}`),
        clock: { now: () => T0, monotonic: () => 0 },
      });
      return { gate, changed, judged, release: (s: Sig) => release(s), fail: (e: Error) => fail(e) };
    }

    it("settled() does not resolve until the late ruling lands", async () => {
      const d = deferredGate();
      d.gate.judge("a");
      let settled = false;
      void d.gate.settled().then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false); // the gate has not ruled yet
      d.release({ size: 1, mtimeMs: STALE });
      await d.gate.settled();
      expect(d.judged).toEqual(["a:old"]); // and the ruling was observed, not skipped
    });

    it("is discarded after close(): nothing is forwarded or reported", async () => {
      const d = deferredGate();
      d.gate.judge("a");
      d.gate.close();
      d.release({ size: 1, mtimeMs: WRITTEN });
      await d.gate.settled();
      expect(d.changed).toEqual([]);
      expect(d.judged).toEqual([]);
    });

    it("is discarded after close() when the stat fails too (the fail-open path)", async () => {
      const d = deferredGate();
      d.gate.judge("a");
      d.gate.close();
      d.fail(new Error("EBUSY"));
      await d.gate.settled();
      expect(d.changed).toEqual([]);
      expect(d.judged).toEqual([]);
    });
  });
});
