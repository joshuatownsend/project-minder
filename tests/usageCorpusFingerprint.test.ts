import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import { preserveEnvVars } from "./_helpers/preserveEnv";

// #476 (Codex P1/P2 on PR #514) — the corpus fingerprint must describe the
// CORPUS, not the cache's residency.
//
// `getJsonlMaxMtime()` and `getJsonlFileCount()` are the two halves of the key
// `getSessionCategoryCounts()` memoises on (#492), and they also feed route
// ETags. Both read `FileCache`, which was the same thing as "the corpus" only
// while it held all of it. Once #476 gave it a byte budget the two diverged,
// and the newest transcript is often also one of the largest — an active
// session grows — so it is exactly the kind of entry eviction takes.
//
// Driven end to end through a real sweep, because the defect is entirely about
// what the fingerprint does when the cache DOES evict.

const state = installIsolatedState({ seedClaudeProjects: true });
preserveEnvVars(["MINDER_PARSE_CACHE_MB"]);

/** A budget far below a single file, so eviction fires on the way in. */
const TINY_BUDGET_MB = "0.0001";

function transcript(sessionId: string, pad: number) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00Z",
    sessionId,
    message: {
      id: "m1",
      model: "claude-opus-5",
      content: [{ type: "text", text: "x".repeat(pad) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
}

async function writeTranscript(dir: string, id: string, pad: number) {
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, transcript(id, pad) + "\n", "utf-8");
  return file;
}

async function seed() {
  await state.reload();
  process.env.MINDER_PARSE_CACHE_MB = TINY_BUDGET_MB;
  const parser = await import("@/lib/usage/parser");
  const dir = path.join(state.tmpHome(), ".claude", "projects", "C--dev-app");
  await fs.mkdir(dir, { recursive: true });
  return { parser, dir };
}

beforeEach(() => vi.clearAllMocks());

describe("corpus fingerprint survives cache eviction (#476)", () => {
  it("counts and dates a transcript the budget evicted", async () => {
    const { parser, dir } = await seed();
    await writeTranscript(dir, "a1111111-1111-1111-1111-111111111111", 4000);

    await parser.parseAllSessions();

    // Nothing resident...
    expect(parser.getJsonlCacheBytes()).toBe(0);
    // ...and the fingerprint unmoved by that, which is the whole point.
    expect(parser.getJsonlFileCount()).toBe(1);
    expect(parser.getJsonlMaxMtime()).toBeGreaterThan(0);
  });

  it("falls when a transcript is deleted, even one already evicted", async () => {
    // The half a monotone watermark could never provide: deleting a file has
    // to be able to LOWER the answer. An earlier revision of this PR recorded
    // a lifetime high-water mark instead, and could not.
    const { parser, dir } = await seed();
    const first = await writeTranscript(
      dir,
      "a1111111-1111-1111-1111-111111111111",
      4000
    );
    await writeTranscript(dir, "b2222222-2222-2222-2222-222222222222", 4000);

    await parser.parseAllSessions();
    expect(parser.getJsonlFileCount()).toBe(2);

    await fs.rm(first);
    await parser.parseAllSessions();
    expect(parser.getJsonlFileCount()).toBe(1);
  });
});
