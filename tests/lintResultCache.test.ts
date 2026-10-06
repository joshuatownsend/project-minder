import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The cache exists so a normal scan spawns no `claudelint` at all. These pin the three things
// that make that safe: a changed file always misses, a failed run is never stored, and the CLI
// never writes its own cache into the project (#610).

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { runLibraryCli } from "@/lib/lint/library";
import {
  MAX_AGE_MS,
  _resetLintCacheForTesting,
  flushLintCache,
  getCachedLintReport,
  lintFingerprint,
  putCachedLintReport,
} from "@/lib/lint/resultCache";
import type { LintReport } from "@/lib/types";

const mockSpawn = vi.mocked(spawn);

function fakeProcess(stdout: string): ChildProcess {
  const out = new EventEmitter();
  const proc = new EventEmitter() as ChildProcess;
  (proc as unknown as { stdout: EventEmitter }).stdout = out;
  Promise.resolve().then(() => {
    out.emit("data", Buffer.from(stdout));
    proc.emit("close", 1);
  });
  return proc;
}

const REPORT = JSON.stringify({
  validators: [
    {
      name: "Agents Validator",
      errors: [{ message: "tools must be array", ruleId: "agent-tools", severity: "error", file: ".claude/agents/a.md" }],
      warnings: [],
    },
  ],
});

let root: string;
let project: string;
let savedState: string | undefined;
let savedCache: string | undefined;

function write(rel: string, content: string) {
  const abs = path.join(project, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-cache-"));
  project = path.join(root, "proj");
  fs.mkdirSync(project);
  write("CLAUDE.md", "# proj\n");
  write("src/index.ts", "export {};\n");
  savedState = process.env.MINDER_STATE_DIR;
  savedCache = process.env.MINDER_LINT_CACHE;
  process.env.MINDER_STATE_DIR = path.join(root, "state");
  delete process.env.MINDER_LINT_CACHE;
  _resetLintCacheForTesting();
  mockSpawn.mockImplementation(() => fakeProcess(REPORT));
});

afterEach(() => {
  _resetLintCacheForTesting();
  if (savedState === undefined) delete process.env.MINDER_STATE_DIR;
  else process.env.MINDER_STATE_DIR = savedState;
  if (savedCache === undefined) delete process.env.MINDER_LINT_CACHE;
  else process.env.MINDER_LINT_CACHE = savedCache;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lintFingerprint", () => {
  it("is stable while nothing the CLI reads has changed", async () => {
    expect(await lintFingerprint(project, "1.0.0")).toBe(await lintFingerprint(project, "1.0.0"));
  });

  it.each([
    ["CLAUDE.md is edited", () => write("CLAUDE.md", "# proj\nmore\n")],
    ["an agent is added", () => write(".claude/agents/a.md", "---\nname: a\n---\n")],
    ["an .mcp.json appears", () => write(".mcp.json", "{}")],
    ["a nested CLAUDE.md appears (the CLI globs **)", () => write("packages/x/CLAUDE.md", "# x\n")],
    ["a plugin-layout skill is added", () => write("skills/s/SKILL.md", "# s\n")],
    ["a .claudelintrc.json appears", () => write(".claudelintrc.json", "{}")],
  ])("changes when %s", async (_name, change) => {
    const before = await lintFingerprint(project, "1.0.0");
    change();
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
  });

  it("changes when a config file in a parent directory appears (the CLI searches upward)", async () => {
    const before = await lintFingerprint(project, "1.0.0");
    fs.writeFileSync(path.join(root, ".claudelintrc.json"), "{}");
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
  });

  it("changes with the CLI version", async () => {
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(await lintFingerprint(project, "1.0.1"));
  });

  it("ignores files the CLI never lints, so ordinary edits keep the cache warm", async () => {
    const before = await lintFingerprint(project, "1.0.0");
    write("src/index.ts", "export const changed = true;\n");
    write("node_modules/dep/CLAUDE.md", "# vendored\n");
    write(".claudelint-cache/x.json", "{}");
    expect(await lintFingerprint(project, "1.0.0")).toBe(before);
  });

  it("returns null for a tree too large to fingerprint, and for a missing directory", async () => {
    for (let i = 0; i < 5; i++) write(`src/f${i}.ts`, "");
    expect(await lintFingerprint(project, "1.0.0", 3)).toBeNull();
    expect(await lintFingerprint(path.join(root, "gone"), "1.0.0")).toBeNull();
  });
});

describe("runLibraryCli caching", () => {
  const run = () => {
    const errors: LintReport["engineErrors"] = [];
    return runLibraryCli(project, errors).then((findings) => ({ findings, errors }));
  };

  it("spawns once, then serves the unchanged project from the cache with identical findings", async () => {
    const first = await run();
    const second = await run();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(first.findings).toHaveLength(1);
    expect(second.findings).toEqual(first.findings);
  });

  it("spawns again after a file the CLI reads changes", async () => {
    await run();
    write(".claude/agents/new.md", "---\nname: new\n---\n");
    await run();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("does not store a failed run", async () => {
    mockSpawn.mockImplementationOnce(() => {
      const proc = new EventEmitter() as ChildProcess;
      (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      Promise.resolve().then(() => proc.emit("error", new Error("boom")));
      return proc;
    });
    expect((await run()).errors).toHaveLength(1);
    await run(); // spawns again: the failure left nothing behind
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await run(); // the successful run WAS stored
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("survives a restart: the report is read back from disk", async () => {
    await run();
    await flushLintCache();
    expect(fs.existsSync(path.join(root, "state", "lint-cache.json"))).toBe(true);
    _resetLintCacheForTesting();
    await run();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("tolerates a corrupt cache file", async () => {
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "lint-cache.json"), "{not json");
    expect((await run()).findings).toHaveLength(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("points the CLI's own cache under the state dir, never into the project (#610)", async () => {
    await run();
    const args = mockSpawn.mock.calls[0][1] as string[];
    const at = args.indexOf("--cache-location");
    expect(at).toBeGreaterThan(-1);
    const dir = args[at + 1];
    expect(dir.startsWith(path.join(root, "state"))).toBe(true);
    expect(dir.startsWith(project)).toBe(false);
  });

  it("MINDER_LINT_CACHE=0 always spawns and writes nothing", async () => {
    process.env.MINDER_LINT_CACHE = "0";
    await run();
    await run();
    await flushLintCache();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(root, "state", "lint-cache.json"))).toBe(false);
  });
});

describe("cache entry freshness", () => {
  it("expires after MAX_AGE_MS, bounding a file the fingerprint missed", async () => {
    const report = { validators: [] };
    await putCachedLintReport(project, "fp", report, 1_000);
    expect(await getCachedLintReport(project, "fp", 1_000 + MAX_AGE_MS)).toBe(report);
    expect(await getCachedLintReport(project, "fp", 1_000 + MAX_AGE_MS + 1)).toBeNull();
  });

  it("misses on a different fingerprint and on a clock that went backwards", async () => {
    await putCachedLintReport(project, "fp", { validators: [] }, 5_000);
    expect(await getCachedLintReport(project, "other", 5_000)).toBeNull();
    expect(await getCachedLintReport(project, "fp", 4_000)).toBeNull();
  });
});
