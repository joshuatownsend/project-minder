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
  clearLintCache,
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

  it("changes on an equal-length rewrite whose mtime is preserved (content, not metadata)", async () => {
    write("CLAUDE.md", "# aaaa\n");
    const when = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(path.join(project, "CLAUDE.md"), when, when);
    const before = await lintFingerprint(project, "1.0.0");
    write("CLAUDE.md", "# bbbb\n");
    fs.utimesSync(path.join(project, "CLAUDE.md"), when, when);
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
  });

  describe("extends", () => {
    it("changes when a relatively extended config is edited", async () => {
      write(".claudelintrc.json", JSON.stringify({ extends: "./base.json" }));
      write("base.json", JSON.stringify({ rules: { a: "off" } }));
      const before = await lintFingerprint(project, "1.0.0");
      write("base.json", JSON.stringify({ rules: { a: "warn" } }));
      expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
    });

    it("follows a chain of extends and tolerates a cycle", async () => {
      write(".claudelintrc.json", JSON.stringify({ extends: ["./a.json"] }));
      write("a.json", JSON.stringify({ extends: "./b.json" }));
      write("b.json", JSON.stringify({ extends: "./a.json" }));
      const before = await lintFingerprint(project, "1.0.0");
      expect(before).not.toBeNull();
      write("b.json", JSON.stringify({ extends: "./a.json", rules: { x: "off" } }));
      expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
    });

    it("follows an extends declared in package.json's claudelint key", async () => {
      write("package.json", JSON.stringify({ claudelint: { extends: "./shared.json" } }));
      write("shared.json", "{}");
      const before = await lintFingerprint(project, "1.0.0");
      write("shared.json", '{"rules":{}}');
      expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
    });

    it("accepts a built-in preset but will not cache an npm-package extends", async () => {
      write(".claudelintrc.json", JSON.stringify({ extends: "claudelint:recommended" }));
      expect(await lintFingerprint(project, "1.0.0")).not.toBeNull();
      write(".claudelintrc.json", JSON.stringify({ extends: "some-shared-config" }));
      expect(await lintFingerprint(project, "1.0.0")).toBeNull();
    });
  });

  it("will not cache a project whose config is reached through a symlink", async (ctx) => {
    fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(root, "shared"));
    try {
      fs.symlinkSync(path.join(root, "shared"), path.join(project, ".claude", "skills"), "junction");
    } catch {
      return ctx.skip(); // no symlink privilege on this machine
    }
    expect(await lintFingerprint(project, "1.0.0")).toBeNull();
  });

  it("does NOT skip build-output directories the CLI still globs (e.g. .next, target)", async () => {
    const before = await lintFingerprint(project, "1.0.0");
    write(".next/server/CLAUDE.md", "# generated\n");
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
    const mid = await lintFingerprint(project, "1.0.0");
    write("target/.mcp.json", "{}");
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(mid);
  });

  describe("hook scripts (hooks-missing-script)", () => {
    const settings = (cmd: string) =>
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd }] }] } });

    it("changes when a referenced ./ script is created, edited, then deleted", async () => {
      write(".claude/settings.json", settings("./scripts/check.sh"));
      const missing = await lintFingerprint(project, "1.0.0");
      write("scripts/check.sh", "echo a\n");
      const created = await lintFingerprint(project, "1.0.0");
      expect(created).not.toBe(missing);
      write("scripts/check.sh", "echo b\n");
      expect(await lintFingerprint(project, "1.0.0")).not.toBe(created);
      fs.rmSync(path.join(project, "scripts", "check.sh"));
      expect(await lintFingerprint(project, "1.0.0")).toBe(missing);
    });

    it("ignores inline commands, which the rule does not check", async () => {
      write(".claude/settings.json", settings("node ./scripts/check.js --flag"));
      const before = await lintFingerprint(project, "1.0.0");
      write("scripts/check.js", "// new\n");
      expect(await lintFingerprint(project, "1.0.0")).toBe(before);
    });
  });

  it("returns null for a config file too large to compare by content", async () => {
    write("CLAUDE.md", "x".repeat(3 * 1024 * 1024));
    expect(await lintFingerprint(project, "1.0.0")).toBeNull();
  });

  it("returns null when the project has executable custom rules", async () => {
    write(".claudelint/rules/mine.ts", "export {};\n");
    expect(await lintFingerprint(project, "1.0.0")).toBeNull();
  });

  it.each([
    ["a root .lsp.json appears", () => write(".lsp.json", "{}")],
    ["a .gitignore is edited", () => write(".gitignore", "build/\n")],
  ])("changes when %s", async (_name, change) => {
    const before = await lintFingerprint(project, "1.0.0");
    change();
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
  });

  it("changes when a .gitignore in a parent directory changes", async () => {
    const before = await lintFingerprint(project, "1.0.0");
    fs.writeFileSync(path.join(root, ".gitignore"), "*.md\n");
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
  });

  it.each([
    ["a plugin manifest", () => write(".claude-plugin/plugin.json", "{}")],
    ["a marketplace manifest", () => write(".claude-plugin/marketplace.json", "{}")],
    ["a settings file using apiKeyHelper", () => write(".claude/settings.json", JSON.stringify({ apiKeyHelper: "./get-key.sh" }))],
  ])("returns null for a project with %s (it names paths the CLI then checks)", async (_name, change) => {
    change();
    expect(await lintFingerprint(project, "1.0.0")).toBeNull();
  });

  it("does not treat an ordinary settings file as uncacheable", async () => {
    write(".claude/settings.json", JSON.stringify({ permissions: { allow: [] } }));
    expect(await lintFingerprint(project, "1.0.0")).not.toBeNull();
  });

  it("changes when an empty config directory appears (a deprecated empty commands/ is itself a finding)", async () => {
    const before = await lintFingerprint(project, "1.0.0");
    fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(before);
  });

  it("abandons a wide tree at the cap instead of reading all of it", async () => {
    for (let i = 0; i < 60; i++) write(`pkg${i}/src/index.ts`, "");
    const readdir = vi.spyOn(fs.promises, "readdir");
    try {
      // 62 entries at the root, then 60 + 60 more below: over the cap of 100 part-way through.
      expect(await lintFingerprint(project, "1.0.0", 100)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50)); // let any straggling reads show up
      // Unbounded scheduling would have read all 121 directories; abandoning stops short of that.
      expect(readdir.mock.calls.length).toBeLessThan(100);
    } finally {
      readdir.mockRestore();
    }
    // and the walk is reusable afterwards (no leaked limiter state)
    expect(await lintFingerprint(project, "1.0.0")).not.toBeNull();
  });

  describe("unreadable inputs", () => {
    const failRead = (code: string) =>
      vi.spyOn(fs.promises, "readFile").mockRejectedValue(Object.assign(new Error(code), { code }));

    it("returns null when a config file cannot be read (permissions, a transient error)", async () => {
      const spy = failRead("EACCES");
      try {
        expect(await lintFingerprint(project, "1.0.0")).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it("treats a file that vanished mid-walk (ENOENT) as absent, not as a reason to give up", async () => {
      const spy = failRead("ENOENT");
      try {
        expect(await lintFingerprint(project, "1.0.0")).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("changes with the CLI version", async () => {
    expect(await lintFingerprint(project, "1.0.0")).not.toBe(await lintFingerprint(project, "1.0.1"));
  });

  it("ignores files the CLI never lints, so ordinary edits keep the cache warm", async () => {
    const before = await lintFingerprint(project, "1.0.0");
    write("src/index.ts", "export const changed = true;\n");
    write("node_modules/dep/CLAUDE.md", "# vendored\n");
    write(".claudelint-cache/x.json", "{}");
    write("dist/CLAUDE.md", "# built\n"); // the CLI's own default ignores
    write("build/.mcp.json", "{}");
    write("coverage/CLAUDE.md", "# c\n");
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

  it("does not store a result if a file the CLI reads changed while it ran", async () => {
    mockSpawn.mockImplementationOnce(() => {
      write(".claude/agents/appeared.md", "---\nname: appeared\n---\n"); // changes mid-run
      return fakeProcess(REPORT);
    });
    await run();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // The tree returns to the state that was fingerprinted before the run (A -> B -> A). Had the
    // run's report been stored under A, this would be a hit serving B's result.
    fs.rmSync(path.join(project, ".claude", "agents", "appeared.md"));
    await run();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await run(); // a stable run IS stored
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("a run in flight when the cache is cleared cannot repopulate it (forced rescan)", async () => {
    let release: () => void = () => {};
    mockSpawn.mockImplementationOnce(() => {
      const out = new EventEmitter();
      const proc = new EventEmitter() as ChildProcess;
      (proc as unknown as { stdout: EventEmitter }).stdout = out;
      release = () => {
        out.emit("data", Buffer.from(REPORT));
        proc.emit("close", 1);
      };
      return proc;
    });
    const inFlight = run();
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    await clearLintCache(); // the user hit Rescan while that lint was running
    release();
    await inFlight;
    await run(); // not served from the pre-clear run's result
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("does not trust or cache the output of a CLI that was killed (timeout)", async () => {
    mockSpawn.mockImplementationOnce(() => {
      const out = new EventEmitter();
      const proc = new EventEmitter() as ChildProcess;
      (proc as unknown as { stdout: EventEmitter }).stdout = out;
      setImmediate(() => {
        out.emit("data", Buffer.from(REPORT)); // valid-looking JSON emitted before the kill
        proc.emit("close", null, "SIGTERM");
      });
      return proc;
    });
    const killed = await run();
    expect(killed.findings).toEqual([]);
    expect(killed.errors).toHaveLength(1);
    expect(killed.errors[0].message).toMatch(/SIGTERM/);
    const next = await run(); // nothing was stored, so this spawns and succeeds
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(next.findings).toHaveLength(1);
  });

  it("treats a malformed cached report as a miss instead of crashing the scan", async () => {
    for (const bad of [
      { validators: {} },
      { validators: [{ name: "X", errors: "nope" }] },
      { validators: [null] },
      { validators: [{ name: "X", errors: [{ message: "m" }] }] }, // no severity: would be served as a warning
      { validators: [{ name: "X", errors: [{ message: "m", severity: "fatal" }] }] },
      { validators: [{ name: "X", warnings: [{ message: "m", severity: "warning", ruleId: 7 }] }] },
    ]) {
      _resetLintCacheForTesting();
      await putCachedLintReport(project, "fp", bad as never);
      await flushLintCache();
      _resetLintCacheForTesting();
      expect(await getCachedLintReport(project, "fp")).toBeNull();
    }
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

  it("runs the CLI with --no-cache so it neither writes into the project (#610) nor serves a stale result", async () => {
    await run();
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--no-cache");
    expect(args).not.toContain("--cache-location");
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

describe("clearLintCache (forced rescan)", () => {
  it("drops every entry, in memory and on disk", async () => {
    await putCachedLintReport(project, "fp", { validators: [] });
    await flushLintCache();
    expect(await getCachedLintReport(project, "fp")).not.toBeNull();
    await clearLintCache();
    expect(await getCachedLintReport(project, "fp")).toBeNull();
    _resetLintCacheForTesting();
    expect(await getCachedLintReport(project, "fp")).toBeNull(); // not resurrected from disk
  });
});

describe("clearLintCache with caching disabled", () => {
  it("still erases what is on disk, so re-enabling cannot resurrect it", async () => {
    await putCachedLintReport(project, "fp", { validators: [] });
    await flushLintCache();
    const file = path.join(root, "state", "lint-cache.json");
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).entries)).toHaveLength(1);
    process.env.MINDER_LINT_CACHE = "0";
    await clearLintCache();
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).entries)).toHaveLength(0);
  });
});

describe("cache entry freshness", () => {
  it("expires after MAX_AGE_MS, bounding an input the fingerprint missed", async () => {
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
