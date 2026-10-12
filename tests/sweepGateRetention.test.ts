/**
 * Wave 5 — the sweep gate lives on globalThis forever, so if it settles to the
 * sweep's value it pins every parsed turn in the corpus (1.35 GB on the tray).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

const g = globalThis as unknown as {
  __usageSweepGate?: Promise<unknown>;
  __usageFileCache?: unknown;
};

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-sweep-gate-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.resetModules();
  delete g.__usageSweepGate;
  delete g.__usageFileCache;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete g.__usageSweepGate;
  delete g.__usageFileCache;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function writeSession(sessionId: string) {
  const dir = path.join(tmpHome, ".claude", "projects", "-home-me-dev-a");
  await fs.mkdir(dir, { recursive: true });
  const line = {
    type: "assistant",
    timestamp: "2026-03-01T10:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  };
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(line) + "\n");
}

describe("sweep gate retention (Wave 5)", () => {
  it("does not hold the parseAllSessions map once the sweep settles", async () => {
    await writeSession("s1");
    await writeSession("s2");
    const { parseAllSessions } = await import("@/lib/usage/parser");

    const map = await parseAllSessions();
    expect(map.size).toBe(2);

    expect(g.__usageSweepGate).toBeDefined();
    await expect(g.__usageSweepGate).resolves.toBeUndefined();
  });
});
