import { describe, it, expect } from "vitest";
import { diffMemoryBodies } from "@/lib/memory/seedDiff";

describe("diffMemoryBodies", () => {
  it("reports zero diff for identical bodies", () => {
    const r = diffMemoryBodies("a\nb\nc", "a\nb\nc");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.equal).toBe(3);
    expect(r.segments.every((s) => s.op === "equal")).toBe(true);
  });

  it("reports adds when proposed has extra trailing lines", () => {
    const r = diffMemoryBodies("a\nb", "a\nb\nc");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.equal).toBe(2);
    const lastAdded = r.segments.find((s) => s.op === "added");
    expect(lastAdded?.text).toBe("c");
    expect(lastAdded?.existingLine).toBeNull();
    expect(lastAdded?.proposedLine).toBe(3);
  });

  it("reports removes when proposed drops lines from existing", () => {
    const r = diffMemoryBodies("a\nb\nc", "a\nc");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(1);
    expect(r.equal).toBe(2);
    const removed = r.segments.find((s) => s.op === "removed");
    expect(removed?.text).toBe("b");
  });

  it("interleaves changed lines as remove+add pairs", () => {
    const r = diffMemoryBodies("a\nold\nc", "a\nnew\nc");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.equal).toBe(2);
  });

  it("preserves original ordering in output segments", () => {
    const r = diffMemoryBodies("a\nb\nc", "a\nb\nx\nc");
    // a (equal), b (equal), x (added), c (equal)
    const lines = r.segments.map((s) => `${s.op}:${s.text}`);
    expect(lines).toEqual(["equal:a", "equal:b", "added:x", "equal:c"]);
  });

  it("handles CRLF on either side without phantom diffs", () => {
    const r = diffMemoryBodies("a\r\nb\r\nc", "a\nb\nc");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.equal).toBe(3);
  });

  it("returns empty proposed as full delete of existing", () => {
    const r = diffMemoryBodies("a\nb", "");
    // "" split on /\r?\n/ yields [""], existing yields ["a","b"] -- no match,
    // so 2 removes + 1 added-blank-line. The UI renders the blank-line add
    // harmlessly; the test pins the contract so we notice if it changes.
    expect(r.removed).toBe(2);
    expect(r.added).toBe(1);
    expect(r.equal).toBe(0);
  });
});
