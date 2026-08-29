import { describe, it, expect } from "vitest";
import { compareCodePoints } from "@/lib/usage/compareNames";

/**
 * #522 — the tie-break must order labels the way SQLite's `BINARY` does, or the
 * two backends render the same corpus in two orders.
 *
 * The interesting cases are the ones where the obvious implementations are
 * wrong, so those are what this file is made of.
 */
describe("compareCodePoints", () => {
  it("is total on strings that locale collation calls equal", () => {
    // `localeCompare` returns 0 for these — distinct strings, equal collation —
    // so a comparator built on it falls back to arrival order for exactly the
    // pair it was meant to separate.
    const composed = "café";
    const decomposed = "café";
    expect(composed).not.toBe(decomposed);
    expect(composed.localeCompare(decomposed)).toBe(0);
    expect(compareCodePoints(composed, decomposed)).not.toBe(0);
    // Antisymmetric, which "not zero" alone does not establish.
    expect(compareCodePoints(decomposed, composed)).toBe(
      -compareCodePoints(composed, decomposed)
    );
  });

  it("orders astral characters above the high BMP, as UTF-8 bytes do", () => {
    // THE case `<` gets wrong. An astral character is a surrogate pair in
    // 0xD800–0xDFFF, so JavaScript's UTF-16 comparison sorts it BELOW U+E000
    // while SQLite's UTF-8 byte comparison sorts it above. A project directory
    // containing an emoji is enough to reach this (Codex P2, PR #524).
    const astral = "\u{10000}";
    const highBmp = "";
    // The premise: the naive comparison really does disagree.
    expect(astral < highBmp).toBe(true);
    // And this one agrees with SQLite.
    expect(compareCodePoints(astral, highBmp)).toBe(1);
    expect(compareCodePoints(highBmp, astral)).toBe(-1);
  });

  it("sorts a prefix before the string that extends it", () => {
    expect(compareCodePoints("model", "model-2")).toBe(-1);
    expect(compareCodePoints("model-2", "model")).toBe(1);
  });

  it("returns 0 only for identical strings", () => {
    expect(compareCodePoints("same", "same")).toBe(0);
    expect(compareCodePoints("", "")).toBe(0);
    expect(compareCodePoints("", "a")).toBe(-1);
  });

  it("produces a consistent total order over a mixed set", () => {
    // Sorting is only well-defined if the comparator is transitive and
    // antisymmetric across the whole set — asserted by sorting the same values
    // from two different starting orders and requiring the same result.
    const values = ["b", "\u{1F600}", "a", "", "café", "café", "", "ab"];
    const one = [...values].sort(compareCodePoints);
    const two = [...values].reverse().sort(compareCodePoints);
    expect(two).toEqual(one);
    // Every adjacent pair strictly increases: no two distinct values tie.
    for (let i = 1; i < one.length; i++) {
      expect(compareCodePoints(one[i - 1], one[i])).toBe(-1);
    }
  });
});
