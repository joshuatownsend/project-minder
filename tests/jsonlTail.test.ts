import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { readTailLines } from "@/lib/jsonlTail";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pm-jsonl-tail-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** What the readers did before (#690): read everything, keep the tail. */
function wholeFileTail(content: string, n: number): string[] {
  return content.split("\n").filter(Boolean).slice(-n);
}

describe("readTailLines", () => {
  it("returns every line of a short file", async () => {
    const content = "a\nb\nc\n";
    expect(await readTailLines(file("short.jsonl", content), 200)).toEqual(["a", "b", "c"]);
  });

  it("keeps the last line when there is no trailing newline, and skips blank lines", async () => {
    const content = "a\n\nb\nc";
    expect(await readTailLines(file("notrail.jsonl", content), 200)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for an empty file", async () => {
    expect(await readTailLines(file("empty.jsonl", ""), 200)).toEqual([]);
  });

  it("matches a whole-file read across many chunks, with multi-byte text on the boundaries", async () => {
    // ~3 MB: 12 read chunks. Every line mixes 1-, 2-, 3- and 4-byte UTF-8 so
    // chunk edges land inside multi-byte characters.
    const lines = Array.from({ length: 6000 }, (_, i) =>
      JSON.stringify({ i, text: `línea ${i} — 日本語 🙂 `.repeat(1 + (i % 17)) }),
    );
    const content = lines.join("\n") + "\n";
    const p = file("big.jsonl", content);
    for (const n of [1, 200, 4999]) {
      expect(await readTailLines(p, n)).toEqual(wholeFileTail(content, n));
    }
  });

  it("returns only complete lines when one line is longer than a read chunk", async () => {
    const huge = JSON.stringify({ blob: "x".repeat(700 * 1024) });
    const content = ["first", huge, "after1", "after2"].join("\n") + "\n";
    const p = file("hugeline.jsonl", content);
    expect(await readTailLines(p, 3)).toEqual([huge, "after1", "after2"]);
    expect(await readTailLines(p, 2)).toEqual(["after1", "after2"]);
  });

  it("never returns a line cut by the read window, even past runs of blank lines", async () => {
    // A long first line, then more blank lines than a chunk's worth of newlines
    // would suggest are real ones: counting newlines alone stops too early.
    const content = "y".repeat(300 * 1024) + "\n" + "\n".repeat(300 * 1024) + "a\nb\n";
    expect(await readTailLines(file("blanks.jsonl", content), 3)).toEqual(wholeFileTail(content, 3));
  });

  it("rejects for a missing file, like the readFile it replaces", async () => {
    await expect(readTailLines(path.join(dir, "missing.jsonl"), 10)).rejects.toThrow();
  });
});
