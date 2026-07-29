import { describe, it, expect } from "vitest";
import { chunkText, CHUNK_SIZE, CHUNK_OVERLAP } from "@/lib/db/textChunks";

// Tests for `src/lib/db/textChunks.ts`. Pure — no DB, no driver guard.
// The overlap property is the one that matters most: it is a correctness
// guarantee (phrases straddling a boundary stay matchable), not a tuning
// preference, and a regression in it fails silently at search time.

describe("chunkText", () => {
  describe("empty and short input", () => {
    it("returns [] for nullish, empty, and whitespace-only text", () => {
      expect(chunkText(null)).toEqual([]);
      expect(chunkText(undefined)).toEqual([]);
      expect(chunkText("")).toEqual([]);
      expect(chunkText("   \n\t  ")).toEqual([]);
    });

    it("returns a single trimmed chunk when the text fits", () => {
      expect(chunkText("  hello world  ")).toEqual(["hello world"]);
    });

    it("returns one chunk at exactly the size boundary", () => {
      const exact = "x".repeat(CHUNK_SIZE);
      expect(chunkText(exact)).toEqual([exact]);
    });

    it("splits at one character over the boundary", () => {
      const over = "x".repeat(CHUNK_SIZE + 1);
      expect(chunkText(over).length).toBe(2);
    });
  });

  describe("chunking", () => {
    it("emits chunks of at most `size`", () => {
      const text = "abcdefghij".repeat(500); // 5000 chars
      for (const c of chunkText(text, 1000, 100)) {
        expect(c.length).toBeLessThanOrEqual(1000);
      }
    });

    it("covers the entire input — no character is dropped", () => {
      // Reassembling by stride must reproduce the original exactly. A
      // silently-truncated tail is the failure mode that would make the
      // last part of long turns unsearchable, which is the bug this whole
      // module exists to fix.
      const text = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      const size = 1000;
      const overlap = 100;
      const chunks = chunkText(text, size, overlap);
      const stride = size - overlap;
      let reassembled = "";
      chunks.forEach((c, i) => {
        reassembled += i === 0 ? c : c.slice(Math.max(0, reassembled.length - i * stride));
      });
      expect(reassembled).toBe(text);
      // Belt and braces: the final chunk must reach the end of the input.
      expect(text.endsWith(chunks[chunks.length - 1])).toBe(true);
    });

    it("overlaps consecutive chunks by exactly `overlap` characters", () => {
      const text = "x".repeat(3000);
      const size = 1000;
      const overlap = 100;
      const chunks = chunkText(text, size, overlap);
      for (let i = 1; i < chunks.length; i++) {
        const prevTail = chunks[i - 1].slice(-overlap);
        expect(chunks[i].startsWith(prevTail)).toBe(true);
      }
    });

    it("keeps a boundary-straddling phrase intact in at least one chunk", () => {
      // The correctness property. Place a marker phrase exactly across a
      // chunk boundary and assert some chunk still contains it whole —
      // without overlap this is precisely the case that silently fails.
      const size = 1000;
      const overlap = 100;
      const phrase = "the migration is failing on production";
      const boundary = size - Math.floor(phrase.length / 2);
      const text = "a".repeat(boundary) + phrase + "b".repeat(2000);
      const chunks = chunkText(text, size, overlap);
      expect(chunks.some((c) => c.includes(phrase))).toBe(true);
    });

    it("does not emit a redundant tail chunk already covered by its predecessor", () => {
      // With size=1000/overlap=100 (stride 900), a 1050-char input is
      // fully covered by chunks starting at 0 and 900. A third chunk at
      // 1800 would be past the end; a second at 900 covering 900..1050 is
      // the last real one.
      const text = "x".repeat(1050);
      const chunks = chunkText(text, 1000, 100);
      expect(chunks.length).toBe(2);
      expect(chunks[chunks.length - 1].length).toBeGreaterThan(0);
    });
  });

  describe("guards", () => {
    it("throws when overlap >= size rather than looping forever", () => {
      // stride = size - overlap would be <= 0, so the loop would never
      // advance and the indexer would hang on a bad constant.
      expect(() => chunkText("some text", 100, 100)).toThrow(RangeError);
      expect(() => chunkText("some text", 100, 200)).toThrow(RangeError);
    });

    it("throws on non-positive size or negative overlap", () => {
      expect(() => chunkText("some text", 0, 0)).toThrow(RangeError);
      expect(() => chunkText("some text", -1, 0)).toThrow(RangeError);
      expect(() => chunkText("some text", 100, -1)).toThrow(RangeError);
    });

    it("validates arguments before the empty-text early return", () => {
      // Otherwise a bad constant is only discovered on the first long turn,
      // long after the misconfiguration was introduced.
      expect(() => chunkText("", 100, 100)).toThrow(RangeError);
      expect(() => chunkText(null, 100, 100)).toThrow(RangeError);
    });
  });

  describe("defaults", () => {
    it("uses CHUNK_SIZE / CHUNK_OVERLAP and keeps overlap < size", () => {
      expect(CHUNK_OVERLAP).toBeLessThan(CHUNK_SIZE);
      const text = "y".repeat(CHUNK_SIZE * 2);
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].length).toBe(CHUNK_SIZE);
      expect(chunks[1].startsWith(chunks[0].slice(-CHUNK_OVERLAP))).toBe(true);
    });
  });
});
