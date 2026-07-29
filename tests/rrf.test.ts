import { describe, it, expect } from "vitest";
import { fuseRrf, RRF_K, type RrfList } from "@/lib/data/rrf";

// Tests for `src/lib/data/rrf.ts`. Deliberately dependency-free — no
// better-sqlite3 guard, no tmp DB, no ingest. The fusion math is the part
// of session search most likely to regress silently, so it must stay
// coverable on every machine and in every CI lane, including ones where
// the native driver isn't loadable.

/** Score a single rank-r hit at the given weight, per the RRF formula. */
const contrib = (rank: number, weight = 1, k = RRF_K) => weight / (k + rank);

describe("fuseRrf", () => {
  it("returns [] when given no lists or only empty lists", () => {
    expect(fuseRrf([])).toEqual([]);
    expect(fuseRrf([{ label: "a", keys: [] }])).toEqual([]);
    expect(
      fuseRrf([
        { label: "a", keys: [] },
        { label: "b", keys: [] },
      ])
    ).toEqual([]);
  });

  it("preserves order for a single list and records 1-based ranks", () => {
    const out = fuseRrf([{ label: "solo", keys: ["x", "y", "z"] }]);
    expect(out.map((r) => r.key)).toEqual(["x", "y", "z"]);
    expect(out[0].ranks).toEqual({ solo: 1 });
    expect(out[2].ranks).toEqual({ solo: 3 });
    expect(out.every((r) => r.topSource === "solo")).toBe(true);
  });

  it("scores by the documented formula weight/(k + rank)", () => {
    const out = fuseRrf([{ label: "a", keys: ["first", "second"] }]);
    expect(out[0].score).toBeCloseTo(contrib(1), 12);
    expect(out[1].score).toBeCloseTo(contrib(2), 12);
  });

  it("sums contributions when both lists find the same item", () => {
    const out = fuseRrf([
      { label: "a", keys: ["shared"] },
      { label: "b", keys: ["shared"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeCloseTo(contrib(1) * 2, 12);
    expect(out[0].ranks).toEqual({ a: 1, b: 1 });
  });

  it("ranks a dual-list hit above a single-list hit that led one list", () => {
    // This is the core RRF property and the reason we adopted it: agreement
    // across retrievers beats a strong showing in just one. "both" is 2nd
    // in each list yet must outrank "onlyA", which is 1st in list A.
    const out = fuseRrf([
      { label: "a", keys: ["onlyA", "both"] },
      { label: "b", keys: ["onlyB", "both"] },
    ]);
    expect(out[0].key).toBe("both");
    expect(out[0].score).toBeCloseTo(contrib(2) * 2, 12);
  });

  it("rescues an item ranked deeply by one retriever and highly by the other", () => {
    // The scenario CANDIDATE_MULTIPLIER exists to make reachable: `deep`
    // is 20th by keyword but 1st by title, and should beat an item that
    // is merely mid-pack in one list alone.
    const many = Array.from({ length: 20 }, (_, i) => (i === 19 ? "deep" : `filler${i}`));
    const out = fuseRrf([
      { label: "prompts", keys: many },
      { label: "titles", keys: ["deep"] },
    ]);
    expect(out[0].key).toBe("deep");
    expect(out[0].ranks).toEqual({ prompts: 20, titles: 1 });
  });

  it("applies per-list weights", () => {
    const lists: RrfList[] = [
      { label: "heavy", keys: ["h"], weight: 1.5 },
      { label: "light", keys: ["l"], weight: 1.0 },
    ];
    const out = fuseRrf(lists);
    expect(out[0].key).toBe("h");
    expect(out[0].score).toBeCloseTo(contrib(1, 1.5), 12);
    expect(out[1].score).toBeCloseTo(contrib(1, 1.0), 12);
  });

  it("reports topSource as the largest single contributor, not the last seen", () => {
    // `t` is rank 3 in the weighted list and rank 1 in the unweighted one.
    // 1.5/63 ≈ 0.0238 vs 1.0/61 ≈ 0.0164 — the weighted list wins despite
    // the worse rank, and despite being fused first.
    const out = fuseRrf([
      { label: "titles", keys: ["x", "y", "t"], weight: 1.5 },
      { label: "prompts", keys: ["t"], weight: 1.0 },
    ]);
    const t = out.find((r) => r.key === "t")!;
    expect(t.ranks).toEqual({ titles: 3, prompts: 1 });
    expect(t.topSource).toBe("titles");
  });

  it("breaks exact contribution ties in favour of the first list", () => {
    // Equal weight, equal rank — input order is the documented tie-break,
    // which is how session search keeps 'titles' winning ties.
    const out = fuseRrf([
      { label: "titles", keys: ["tie"] },
      { label: "prompts", keys: ["tie"] },
    ]);
    expect(out[0].topSource).toBe("titles");
  });

  it("ignores duplicate keys within one list rather than double-counting", () => {
    // A retriever that accidentally emitted a key twice must not be able
    // to manufacture a dual-hit score for a single-retriever match.
    const dup = fuseRrf([{ label: "a", keys: ["d", "other", "d"] }]);
    expect(dup).toHaveLength(2);
    const d = dup.find((r) => r.key === "d")!;
    expect(d.score).toBeCloseTo(contrib(1), 12);
    expect(d.ranks).toEqual({ a: 1 });
  });

  it("sorts ties by key so truncated results are stable across runs", () => {
    // Without a deterministic tie-break, `limit`-sliced output could flap
    // between identical queries depending on Map iteration order.
    const out = fuseRrf([{ label: "a", keys: ["b"] }, { label: "b", keys: ["a"] }]);
    expect(out.map((r) => r.key)).toEqual(["a", "b"]);
    expect(out[0].score).toBeCloseTo(out[1].score, 12);
  });

  it("honours a custom k, damping harder as k grows", () => {
    const spread = (k: number) => {
      const out = fuseRrf([{ label: "a", keys: ["first", "twentieth"] }], k);
      // Ratio of best to worst — larger k flattens it toward 1.
      return out[0].score / out[1].score;
    };
    expect(spread(0)).toBeGreaterThan(spread(60));
    expect(spread(60)).toBeGreaterThan(spread(600));
    expect(spread(600)).toBeGreaterThan(1);
  });

  it("produces strictly positive scores", () => {
    const out = fuseRrf([{ label: "a", keys: ["only"] }]);
    expect(out[0].score).toBeGreaterThan(0);
    expect(out[0].score).toBeLessThan(1);
  });
});
