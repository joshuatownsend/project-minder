import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { extractRefCandidates, verifyRefs } from "@/lib/memory/staleRefs";

// Two test surfaces:
//   1. extractRefCandidates — pure, no FS. Coverage on fence handling, URL
//      stripping, dedup, ext filter, "must contain a slash" guard.
//   2. verifyRefs — touches FS via fs.stat. Uses a real tmpdir like the
//      memoryDiscovery tests do (mocking fs would force us to mirror node:fs
//      semantics by hand, which silently drifts).

describe("extractRefCandidates", () => {
  it("returns empty array for empty input", () => {
    expect(extractRefCandidates("")).toEqual([]);
  });

  it("matches POSIX-style refs with recognized extensions", () => {
    const md = "see src/lib/foo.ts and app/api/users/route.ts for details";
    expect(extractRefCandidates(md).sort()).toEqual([
      "app/api/users/route.ts",
      "src/lib/foo.ts",
    ]);
  });

  it("skips bare filenames without a slash", () => {
    const md = "the file index.ts is at src/lib/foo.ts";
    // index.ts (no slash) skipped; src/lib/foo.ts kept
    expect(extractRefCandidates(md)).toEqual(["src/lib/foo.ts"]);
  });

  it("skips files with extensions outside the allowlist", () => {
    const md = "see src/foo.bak and app/icon.png and notes/x.txt";
    expect(extractRefCandidates(md)).toEqual([]);
  });

  it("strips triple-fenced code blocks before extraction", () => {
    const md = `Real ref: src/lib/keep.ts
\`\`\`ts
// This example mentions src/lib/skip.ts but it's in a fence
import foo from "src/lib/should-skip.ts";
\`\`\`
Another real one: app/page.tsx
`;
    const out = extractRefCandidates(md).sort();
    expect(out).toEqual(["app/page.tsx", "src/lib/keep.ts"]);
  });

  it("strips URLs so github.com/foo/bar.ts isn't surfaced", () => {
    const md = "see https://github.com/foo/bar.ts and real src/lib/x.ts";
    expect(extractRefCandidates(md)).toEqual(["src/lib/x.ts"]);
  });

  it("matches refs inside inline backtick spans", () => {
    const md = "the entry point lives in `src/lib/entry.ts` — important";
    expect(extractRefCandidates(md)).toEqual(["src/lib/entry.ts"]);
  });

  it("matches home-relative refs (~/foo/bar.md)", () => {
    const md = "see ~/.claude/projects/foo/MEMORY.md for the index shape";
    expect(extractRefCandidates(md)).toEqual([
      "~/.claude/projects/foo/MEMORY.md",
    ]);
  });

  it("preserves first-occurrence order across duplicates", () => {
    const md = "src/a.ts then src/b.ts then src/a.ts again";
    expect(extractRefCandidates(md)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not half-match foo.ts.bak as foo.ts", () => {
    const md = "the backup at src/lib/foo.ts.bak should not match";
    expect(extractRefCandidates(md)).toEqual([]);
  });

  it("covers every allowed extension", () => {
    const exts = [
      "ts", "tsx", "js", "jsx", "mjs", "cjs",
      "md", "json", "sql", "yml", "yaml", "toml",
      "sh", "py", "go", "rs",
    ];
    for (const ext of exts) {
      const out = extractRefCandidates(`prefix src/dir/file.${ext} suffix`);
      expect(out, `extension ${ext}`).toContain(`src/dir/file.${ext}`);
    }
  });
});

describe("verifyRefs", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "minder-refs-"));
  });

  afterEach(async () => {
    try { await fs.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it("returns empty when all refs resolve under parent project", async () => {
    const proj = path.join(tmp, "projA");
    await fs.mkdir(path.join(proj, "src", "lib"), { recursive: true });
    await fs.writeFile(path.join(proj, "src", "lib", "foo.ts"), "x");
    const broken = await verifyRefs(
      ["src/lib/foo.ts"],
      { parent: proj, all: [proj] },
    );
    expect(broken).toEqual([]);
  });

  it("flags refs that don't resolve in parent nor fallback projects", async () => {
    const proj = path.join(tmp, "projA");
    await fs.mkdir(proj, { recursive: true });
    const broken = await verifyRefs(
      ["src/lib/never-existed.ts"],
      { parent: proj, all: [proj] },
    );
    expect(broken).toEqual(["src/lib/never-existed.ts"]);
  });

  it("falls back to other projects when parent has no match", async () => {
    const a = path.join(tmp, "projA");
    const b = path.join(tmp, "projB");
    await fs.mkdir(path.join(b, "shared"), { recursive: true });
    await fs.writeFile(path.join(b, "shared", "util.ts"), "x");
    await fs.mkdir(a);
    const broken = await verifyRefs(
      ["shared/util.ts"],
      { parent: a, all: [a, b] },
    );
    expect(broken).toEqual([]);
  });

  it("resolves home-relative refs against the OS homedir", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
    await fs.mkdir(path.join(tmp, ".claude"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".claude", "CLAUDE.md"), "u");
    const broken = await verifyRefs(
      ["~/.claude/CLAUDE.md", "~/.claude/missing.md"],
      { parent: null, all: [] },
    );
    expect(broken).toEqual(["~/.claude/missing.md"]);
  });

  it("memoizes (project, candidate) pairs across calls", async () => {
    const proj = path.join(tmp, "projA");
    await fs.mkdir(path.join(proj, "src"), { recursive: true });
    await fs.writeFile(path.join(proj, "src", "ok.ts"), "x");

    const memo = new Map<string, boolean>();
    const a = await verifyRefs(["src/ok.ts"], { parent: proj, all: [proj] }, memo);
    const b = await verifyRefs(["src/ok.ts"], { parent: proj, all: [proj] }, memo);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    // One entry for "<proj>::src/ok.ts" — second call hit the memo, no second stat.
    expect(memo.size).toBe(1);
  });

  it("treats a directory as a non-file (not resolved)", async () => {
    const proj = path.join(tmp, "projA");
    await fs.mkdir(path.join(proj, "src", "lib"), { recursive: true });
    // "src/lib" is a dir, not a file — ref `src/lib.ts` would not match,
    // but `src/lib/index.ts` against a non-existent file should be flagged.
    const broken = await verifyRefs(
      ["src/lib/index.ts"],
      { parent: proj, all: [proj] },
    );
    expect(broken).toEqual(["src/lib/index.ts"]);
  });
});
