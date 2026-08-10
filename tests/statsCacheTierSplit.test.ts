import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

/**
 * Issue #394 — a scan-cache hit must re-price to the same number as the parse
 * that filled it.
 *
 * The file-parse backend persists per-file stats to `claude-stats.json` and
 * re-prices from that entry whenever the transcript is unchanged. It used to
 * store flat token totals only, so the recompute lost three rate-selecting
 * dimensions at once:
 *
 *   - **the model** — every token was attributed to an `unknown` bucket priced
 *     at Sonnet rates, so an Opus transcript came back far under;
 *   - **the long-context tier** — everything landed in `base`;
 *   - **the 1-hour cache-write TTL** — everything billed at the 5-minute rate.
 *
 * The visible symptom was the nastiest kind: the displayed cost *changed after
 * the first scan and then stayed low*. A number that silently drifts downward
 * on second look is worse than one that is consistently wrong, because it
 * defeats comparison against an earlier screenshot or export.
 *
 * The fix persists the same per-model/per-rate split the fresh parse computes.
 * The property under test is therefore equality between the two paths — and,
 * in the last test, that the persisted split is genuinely load-bearing rather
 * than decorative.
 */

const OPUS = "claude-opus-5";
const SONNET_TIERED = "claude-sonnet-4-5";

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalStateDir: string | undefined;

function assistantLine(
  model: string,
  usage: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-10T12:00:00.000Z",
    message: { model, usage, content: [] },
  });
}

/**
 * A transcript that exercises every dimension the cache has to carry. Each turn
 * is here to defeat a different partial fix:
 *   1. plain Opus       — model attribution (Opus is 1.67x Sonnet)
 *   2. long Sonnet 4.5  — the >200k tier, cache-dominated
 *   3. fast Opus        — the speed dimension (2x)
 *   4. 1h cache writes  — the TTL split (2x vs 1.25x base)
 */
const TRANSCRIPT = [
  assistantLine(OPUS, { input_tokens: 10_000, output_tokens: 2_000 }),
  assistantLine(SONNET_TIERED, {
    input_tokens: 5_000,
    output_tokens: 1_000,
    cache_read_input_tokens: 220_000,
  }),
  assistantLine(OPUS, {
    input_tokens: 8_000,
    output_tokens: 1_500,
    speed: "fast",
  }),
  assistantLine(OPUS, {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_creation_input_tokens: 50_000,
    cache_creation: { ephemeral_1h_input_tokens: 50_000, ephemeral_5m_input_tokens: 0 },
  }),
].join("\n");

const CACHE_FILE = () => path.join(tmpHome, ".cache", "claude-stats.json");

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalStateDir = process.env.MINDER_STATE_DIR;

  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-statscache-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // The stats cache resolves `CACHE_DIR` at module scope from this variable, so
  // it must be set before the first import below — hence `vi.resetModules()`
  // inside `freshScanner()` rather than a top-level import.
  process.env.MINDER_STATE_DIR = tmpHome;

  const projectDir = path.join(tmpHome, ".claude", "projects", "C--dev-demo");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "session.jsonl"), TRANSCRIPT, "utf-8");
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalStateDir === undefined) delete process.env.MINDER_STATE_DIR;
  else process.env.MINDER_STATE_DIR = originalStateDir;
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

async function freshScanner() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return import("@/lib/scanner/claudeConversations");
}

async function readCache(): Promise<{
  version: number;
  entries: Record<string, Record<string, unknown>>;
}> {
  return JSON.parse(await fs.readFile(CACHE_FILE(), "utf-8"));
}

describe("scan-cache tier split (#394)", () => {
  it("prices a cache hit identically to the parse that filled the cache", async () => {
    const first = await (await freshScanner()).scanAllClaudeConversations();
    expect(first.costEstimate).toBeGreaterThan(0);

    // Second scan: transcript untouched, so every file is a cache hit.
    const second = await (await freshScanner()).scanAllClaudeConversations();

    expect(second.conversationCount).toBe(first.conversationCount);
    expect(second.costEstimate).toBeCloseTo(first.costEstimate, 10);
  });

  it("persists the per-model split, keyed by model and split by rate", async () => {
    await (await freshScanner()).scanAllClaudeConversations();

    const cache = await readCache();
    expect(cache.version).toBe(2);

    const entry = Object.values(cache.entries)[0] as {
      perModel?: Record<string, Record<string, unknown>>;
    };
    expect(entry.perModel).toBeDefined();
    const perModel = entry.perModel!;

    // Both models kept apart — the collapse to a single `unknown` bucket was
    // the largest of the three losses.
    expect(Object.keys(perModel).sort()).toEqual([OPUS, SONNET_TIERED].sort());
    // Opus: a standard bucket and a fast bucket, no long bucket.
    expect(perModel[OPUS].base).toBeDefined();
    expect(perModel[OPUS].fast).toBeDefined();
    expect(perModel[OPUS].long).toBeUndefined();
    // Sonnet: the 225k-prompt turn is long, and nothing else is.
    expect(perModel[SONNET_TIERED].long).toBeDefined();
    expect(perModel[SONNET_TIERED].base).toBeUndefined();
    // The 1-hour TTL slice survives as its own field on the Opus base bucket.
    expect((perModel[OPUS].base as { cc1h: number }).cc1h).toBe(50_000);
  });

  it("discards a cache written by an older version rather than misreading it", async () => {
    await (await freshScanner()).scanAllClaudeConversations();
    // Awaited before the file is touched below. Leaving this scan in flight
    // races the rewrite: it reads and may rewrite the very cache file the next
    // statement stamps, so it could observe the v1 stamp or a half-written
    // file. Nothing about the assertion needs it to be concurrent.
    const expected = await (await freshScanner()).scanAllClaudeConversations();

    // Stamp the file back to v1, the shape that had no `perModel` at all.
    const cache = await readCache();
    await fs.writeFile(
      CACHE_FILE(),
      JSON.stringify({ ...cache, version: 1 }),
      "utf-8",
    );

    const after = await (await freshScanner()).scanAllClaudeConversations();
    // A discarded cache means a full re-parse, which must reproduce the
    // original number exactly — not a degraded one.
    expect(after.costEstimate).toBeCloseTo(expected.costEstimate, 10);
  });

  it("the session list prices the same transcript as the aggregate scanner", async () => {
    // Codex review of #423. `scanSessionFile` keeps its own token accumulation
    // for the session list's `costEstimate`, and it had its own
    // `accumulateTurn` call that was not passing `speed`. A fast turn therefore
    // priced at half rate on /sessions while the aggregate scanner and the
    // SQLite backend both priced it correctly — a disagreement visible only by
    // holding two screens side by side, which is why the parity is asserted
    // here rather than the fast rate alone.
    const mod = await freshScanner();
    const aggregate = await mod.scanAllClaudeConversations();
    const sessions = await mod.scanAllSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].costEstimate).toBeGreaterThan(0);
    expect(sessions[0].costEstimate).toBeCloseTo(aggregate.costEstimate, 10);
  });

  it("the persisted split is load-bearing: removing it changes the answer", async () => {
    // This is the discrimination check. If stripping `perModel` left the cost
    // unchanged, every assertion above would be measuring nothing — the split
    // could be dead weight and the tests would still pass.
    const first = await (await freshScanner()).scanAllClaudeConversations();

    const cache = await readCache();
    for (const entry of Object.values(cache.entries)) delete entry.perModel;
    await fs.writeFile(CACHE_FILE(), JSON.stringify(cache), "utf-8");

    const degraded = await (await freshScanner()).scanAllClaudeConversations();

    // Same tokens, different money — and lower, since the fallback attribution
    // prices everything as flat, standard-speed, base-tier Sonnet.
    expect(degraded.inputTokens).toBe(first.inputTokens);
    expect(degraded.costEstimate).toBeLessThan(first.costEstimate);
    expect(degraded.costEstimate / first.costEstimate).toBeLessThan(0.9);
  });
});
