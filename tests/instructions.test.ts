import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// readConfig is mocked so the enabledAdapters-gating tests are hermetic (they
// don't read the repo's real .minder.json). walkCodexInstructions itself takes
// no config — it's driven entirely by CODEX_HOME, set to a temp dir per test.
vi.mock("@/lib/config", () => ({ readConfig: vi.fn() }));
import { readConfig } from "@/lib/config";
import {
  walkCodexInstructions,
  loadInstructions,
  invalidateInstructionsCache,
} from "@/lib/indexer/instructions";

let tmpHome: string;
let originalCodexHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-instr-"));
  originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpHome;
  invalidateInstructionsCache();
  vi.mocked(readConfig).mockReset();
});

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  vi.restoreAllMocks();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function write(rel: string, content: string): Promise<void> {
  const fp = path.join(tmpHome, rel);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, content, "utf-8");
}

describe("walkCodexInstructions", () => {
  it("returns [] when the codex home has no instruction artifacts", async () => {
    expect(await walkCodexInstructions()).toEqual([]);
  });

  it("indexes rules/, prompts/, and AGENTS.md with harness + category + frontmatter", async () => {
    await write("rules/style.md", "---\nname: Style Guide\ndescription: how to write\n---\nBody text here");
    await write("rules/legacy.rules", "no frontmatter, just prose");
    await write("prompts/review.md", "Review prompt body");
    await write("AGENTS.md", "Top-level agents instructions");

    const entries = await walkCodexInstructions();

    expect(entries.every((e) => e.harness === "codex")).toBe(true);
    expect(entries.every((e) => e.kind === "instruction")).toBe(true);
    expect(entries.every((e) => e.source === "user")).toBe(true);
    expect(entries.every((e) => (e.fileBytes ?? 0) > 0)).toBe(true);

    const byId = new Map(entries.map((e) => [e.id, e]));

    const style = byId.get("instruction:codex:rules:style");
    expect(style).toBeDefined();
    expect(style!.name).toBe("Style Guide"); // from frontmatter
    expect(style!.description).toBe("how to write");
    expect(style!.category).toBe("rules");

    const legacy = byId.get("instruction:codex:rules:legacy");
    expect(legacy).toBeDefined();
    expect(legacy!.name).toBe("legacy"); // no frontmatter → falls back to slug

    expect(byId.get("instruction:codex:prompts:review")?.category).toBe("prompts");
    expect(byId.get("instruction:codex:agents:AGENTS")?.category).toBe("agents");
  });

  it("ignores dotfiles and unrelated extensions", async () => {
    await write("rules/.hidden.md", "x");
    await write("rules/notes.json", "{}");
    await write("rules/keep.md", "kept");
    const entries = await walkCodexInstructions();
    expect(entries.map((e) => e.slug)).toEqual(["keep"]);
  });

  it("captures parseWarnings for malformed frontmatter (degrades, never throws)", async () => {
    await write("rules/bad.md", "---\nname: [unclosed\n---\nbody");
    const entries = await walkCodexInstructions();
    const bad = entries.find((e) => e.slug === "bad");
    expect(bad).toBeDefined();
    expect((bad!.parseWarnings ?? []).length).toBeGreaterThan(0);
  });

  it("reads only a bounded prefix but reports the true file size", async () => {
    // A file far larger than the 64KB read cap: only a prefix is read for the
    // excerpt, but fileBytes reflects the real on-disk size (from stat), and
    // the excerpt stays capped at 400 chars.
    const big = "a".repeat(200_000);
    await write("rules/big.md", big);
    const entries = await walkCodexInstructions();
    const entry = entries.find((e) => e.slug === "big");
    expect(entry).toBeDefined();
    expect(entry!.fileBytes).toBe(200_000);
    expect(entry!.bodyExcerpt.length).toBeLessThanOrEqual(400);
  });

  it("follows symlinked instruction files (degrades where symlinks need elevation)", async () => {
    await write("rules/real.md", "real body");
    let symlinked = false;
    try {
      await fs.symlink(
        path.join(tmpHome, "rules", "real.md"),
        path.join(tmpHome, "rules", "link.md")
      );
      symlinked = true;
    } catch {
      // Windows without Developer Mode / elevation can't create symlinks —
      // skip the symlink assertion there; the real-file assertion still holds.
    }
    const entries = await walkCodexInstructions();
    expect(entries.some((e) => e.slug === "real")).toBe(true);
    if (symlinked) {
      expect(entries.some((e) => e.slug === "link")).toBe(true);
    }
  });
});

describe("loadInstructions (enabledAdapters gating)", () => {
  it("returns [] when codex is not enabled (explicit claude-only)", async () => {
    await write("rules/x.md", "x");
    vi.mocked(readConfig).mockResolvedValue({ enabledAdapters: ["claude"] } as never);
    expect(await loadInstructions()).toEqual([]);
  });

  it("returns [] when enabledAdapters is unset (defaults to claude-only)", async () => {
    await write("rules/x.md", "x");
    vi.mocked(readConfig).mockResolvedValue({} as never);
    expect(await loadInstructions()).toEqual([]);
  });

  it("includes codex instructions when codex is enabled", async () => {
    await write("rules/x.md", "x");
    vi.mocked(readConfig).mockResolvedValue({ enabledAdapters: ["claude", "codex"] } as never);
    const entries = await loadInstructions();
    expect(entries).toHaveLength(1);
    expect(entries[0].harness).toBe("codex");
    expect(entries[0].slug).toBe("x");
  });

  it("reflects an adapter toggle within the TTL without an explicit cache invalidation", async () => {
    // The cache is keyed by the enabled-adapter set, so flipping codex on (then
    // off) is seen immediately — no invalidateInstructionsCache() call between.
    await write("rules/x.md", "x");

    vi.mocked(readConfig).mockResolvedValue({ enabledAdapters: ["claude"] } as never);
    expect(await loadInstructions()).toEqual([]); // primes the cache (claude-only)

    vi.mocked(readConfig).mockResolvedValue({ enabledAdapters: ["claude", "codex"] } as never);
    expect(await loadInstructions()).toHaveLength(1); // key changed → cache miss

    vi.mocked(readConfig).mockResolvedValue({ enabledAdapters: ["claude"] } as never);
    expect(await loadInstructions()).toEqual([]); // toggled back off, still no invalidate
  });
});
