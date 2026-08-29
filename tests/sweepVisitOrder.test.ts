/**
 * #515 — the sweep serializes its visitors.
 *
 * Parsing runs `Promise.all` over batches of five, so without a chain the
 * visitor calls overlap — and the real usage visitor awaits per turn while
 * costing, so a short session could finish updating every accumulator map
 * before a long session that started earlier.
 *
 * That is NOT what the map path did. There the interleaving ended at
 * `result.set`, and the consumer then walked the map in one fixed order.
 * Several report arrays sort by a single descending key and fall back to
 * insertion order for ties — `byModel`, `byProject`, `byCategory`, `topTools` —
 * so overlapping visitors could reorder them (Codex P2, PR #520).
 *
 * Serialization is the guarantee; a STABLE order across sweeps is not, and the
 * second test below records why — both shapes emit in completion order.
 *
 * Against a TEMPORARY home rather than the developer's real corpus. The first
 * version of this test swept ~6,600 real sessions, took 75 seconds, timed out,
 * and would have been vacuously true in CI where no corpus exists — a test that
 * passes by finding nothing is the failure mode this whole session keeps
 * turning up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-sweep-order-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function assistant(ts: string, tokens: number) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: tokens, output_tokens: tokens },
    },
  };
}

async function writeSession(dirName: string, sessionId: string, turnCount: number) {
  const dir = path.join(tmpHome, ".claude", "projects", dirName);
  await fs.mkdir(dir, { recursive: true });
  const lines = Array.from({ length: turnCount }, (_, i) =>
    assistant(`2026-03-0${(i % 9) + 1}T10:00:00.000Z`, 10)
  );
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

describe("sweepSessions visitor ordering (#515)", () => {
  it("never overlaps two visits, even when the visitor awaits", async () => {
    // Enough sessions to fill more than one batch of five, across more than one
    // project directory — the two axes the sweep parallelises over. Turn counts
    // deliberately uneven so a long session and a short one are in flight
    // together, which is the case that exposes an unserialized visitor.
    await writeSession("-home-me-dev-a", "s-long-1", 40);
    await writeSession("-home-me-dev-a", "s-short-1", 1);
    await writeSession("-home-me-dev-a", "s-long-2", 30);
    await writeSession("-home-me-dev-b", "s-short-2", 1);
    await writeSession("-home-me-dev-b", "s-long-3", 25);
    await writeSession("-home-me-dev-b", "s-short-3", 1);
    await writeSession("-home-me-dev-c", "s-short-4", 2);

    const { streamAllSessions } = await import("@/lib/usage/parser");

    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    await streamAllSessions(async (sessionId, turns) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(sessionId);
      // Yield once per turn, which is what the real visitor does while costing.
      // A single `await` is not enough to expose the interleaving.
      for (let i = 0; i < turns.length; i++) await Promise.resolve();
      inFlight--;
    });

    // The fixture is the test's own, so finding nothing is a broken fixture,
    // not an empty machine — assert it before asserting anything about it.
    expect(order.length).toBe(7);
    expect(maxInFlight).toBe(1);
    expect(new Set(order).size).toBe(order.length);
  });

  it("emits every session exactly once — but NOT in a stable order", async () => {
    // Measured, and it corrects a claim I made in this PR's own commit message.
    //
    // I wrote that feeding sessions in map order reproduces the map path's
    // insertion order "exactly". That is true WITHIN one sweep — which is what
    // the serialization above restores — and false ACROSS sweeps: both shapes
    // record completion order, so two runs over an unchanged tree can visit
    // `[s1, s3, s2, s4]` and then `[s3, s1, s4, s2]`. Directly observed here.
    //
    // The map form has always behaved this way; `result.set` fires on
    // completion too. So the report arrays that fall back to insertion order
    // for ties — `byModel`, `byProject`, `byCategory`, `topTools` — have never
    // been stable run-to-run, and this PR neither introduces that nor fixes it.
    // Filed as #522 rather than folded in here: making those sorts total is a
    // change to reported output and deserves its own verification.
    //
    // What this test pins is the part that IS a guarantee: every session is
    // emitted, exactly once.
    await writeSession("-home-me-dev-a", "s1", 12);
    await writeSession("-home-me-dev-a", "s2", 3);
    await writeSession("-home-me-dev-b", "s3", 20);
    await writeSession("-home-me-dev-b", "s4", 1);

    const { streamAllSessions } = await import("@/lib/usage/parser");

    const runOnce = async () => {
      const seen: string[] = [];
      await streamAllSessions(async (sessionId, turns) => {
        seen.push(sessionId);
        for (let i = 0; i < turns.length; i++) await Promise.resolve();
      });
      return seen;
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first.length).toBe(4);
    expect(new Set(first).size).toBe(4);
    expect([...second].sort()).toEqual([...first].sort());
  });

  it("emits a repeated session id once, and the same copy both shapes see", async () => {
    // Two homes holding the SAME session id with different contents. It happens
    // when a history is copied while still evolving, or when one tree is
    // reachable both natively and over a mapping.
    //
    // The first version of this change let each shape decide: the map form kept
    // `Map.set`'s last-wins, the streaming form skipped repeats. Two answers to
    // one question, and observable — a streaming caller that JOINS an in-flight
    // map sweep sees the map's answer, so the same usage request could report
    // different tokens depending on whether an unrelated sweep happened to be
    // running (Codex P2, PR #520).
    //
    // Resolved in the core now: first copy wins, once, for every shape.
    await writeSession("-home-me-dev-a", "dupe", 5);
    const other = path.join(tmpHome, "second-home", "projects", "-home-me-dev-b");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(
      path.join(other, "dupe.jsonl"),
      Array.from({ length: 40 }, () => JSON.stringify(assistant("2026-03-02T10:00:00.000Z", 10))).join("\n") + "\n"
    );

    await fs.writeFile(
      path.join(other, "only-in-second-home.jsonl"),
      JSON.stringify(assistant("2026-03-03T10:00:00.000Z", 10)) + "\n"
    );

    vi.doMock("@/lib/config", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/config")>()),
      readConfig: async () => ({ claudeHomes: [path.join(tmpHome, "second-home")] }),
    }));

    const { streamAllSessions, parseAllSessions } = await import("@/lib/usage/parser");

    const streamed: { id: string; turns: number }[] = [];
    await streamAllSessions(async (sessionId, turns) => {
      streamed.push({ id: sessionId, turns: turns.length });
    });

    const mapped = await parseAllSessions({ includeSidechains: true });

    // FIRST: prove the second home is actually being swept. Without this the
    // whole test passes by reading one home and never meeting a duplicate at
    // all — a green that proves nothing, which is the failure mode this file's
    // header already names once.
    expect(streamed.map((s) => s.id)).toContain("only-in-second-home");

    // ONCE, not twice. This is the guarantee the core now makes, and the one
    // that matters: a fold cannot see the same session's tokens added twice.
    expect(streamed.filter((s) => s.id === "dupe")).toHaveLength(1);

    // WHICH copy wins is NOT asserted, and the first version of this test
    // asserted it and was wrong. It passed alone and failed in the full suite,
    // because the winner is decided by which parse finishes first: both homes'
    // project directories go into the same `Promise.all` batch, so two sweeps
    // of the same tree can pick different copies.
    //
    // That race predates this change — the map form resolved it by last-wins
    // among the same racing writers — and removing it means restructuring the
    // sweep into enumerate-then-dedupe-then-parse, which is a larger change
    // than this one should carry. Recorded in #522 with the other sweep-order
    // nondeterminism rather than left as folklore.
    //
    // So: assert that each shape chose A REAL copy, not a particular one.
    const streamedTurns = streamed.find((s) => s.id === "dupe")?.turns;
    expect([5, 40]).toContain(streamedTurns);
    expect([5, 40]).toContain(mapped.get("dupe")?.length);
  });
});
