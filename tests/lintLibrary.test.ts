import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process to avoid real subprocess spawning.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import { runLibraryCli } from "@/lib/lint/library";
import type { LintReport } from "@/lib/types";

const mockSpawn = vi.mocked(spawn);

function makeFakeProcess(stdout: string, exitCode = 0): ChildProcess {
  const stdoutEmitter = new EventEmitter();
  const proc = new EventEmitter() as ChildProcess;
  (proc as unknown as { stdout: EventEmitter }).stdout = stdoutEmitter;

  // Emit stdout + close on next tick.
  Promise.resolve().then(() => {
    stdoutEmitter.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  });
  return proc;
}

const SAMPLE_REPORT = JSON.stringify({
  valid: false,
  errorCount: 2,
  warningCount: 1,
  validators: [
    {
      name: "CLAUDE.md Validator",
      errors: [{ message: "Import in code block", ruleId: "claude-md-import-in-code-block", severity: "error", file: "CLAUDE.md" }],
      warnings: [],
    },
    {
      name: "Agents Validator",
      errors: [{ message: "tools must be array", ruleId: "agent-tools", severity: "error", file: ".claude/agents/foo.md", howToFix: "Use YAML array." }],
      warnings: [{ message: "body too short", ruleId: "agent-body-too-short", severity: "warning", file: ".claude/agents/bar.md" }],
    },
    {
      name: "Commands Validator",
      errors: [],
      warnings: [{ message: "directory deprecated", ruleId: "commands-deprecated-directory", severity: "warning" }],
    },
  ],
});

beforeEach(() => vi.clearAllMocks());

describe("runLibraryCli", () => {
  it("maps agent error findings to P1 with agent target", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(SAMPLE_REPORT, 1));
    const errors: LintReport["engineErrors"] = [];
    const findings = await runLibraryCli("/project", errors);

    const agentError = findings.find((f) => f.target === "agent" && f.severity === "P1");
    expect(agentError).toBeDefined();
    expect(agentError?.code).toBe("agent/agent-tools");
    expect(agentError?.engine).toBe("library");
  });

  it("maps agent warning findings to P2", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(SAMPLE_REPORT, 1));
    const findings = await runLibraryCli("/project", []);
    const agentWarn = findings.find((f) => f.target === "agent" && f.severity === "P2");
    expect(agentWarn).toBeDefined();
    expect(agentWarn?.code).toBe("agent/agent-body-too-short");
  });

  it("excludes CLAUDE.md Validator findings (adapter handles those)", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(SAMPLE_REPORT, 1));
    const findings = await runLibraryCli("/project", []);
    // "CLAUDE.md Validator" is not in the VALIDATOR_TARGET map, so the library
    // wrapper skips it entirely — the adapter pass surfaces those findings instead.
    const claudeMdFindings = findings.filter((f) => f.target === "claude-md");
    expect(claudeMdFindings).toHaveLength(0);
  });

  it("preserves file path on findings that have one", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(SAMPLE_REPORT, 1));
    const findings = await runLibraryCli("/project", []);
    const withFile = findings.find((f) => f.file === ".claude/agents/foo.md");
    expect(withFile).toBeDefined();
  });

  it("records engineError and returns [] on spawn error", async () => {
    const proc = new EventEmitter() as ChildProcess;
    (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    Promise.resolve().then(() => proc.emit("error", new Error("ENOENT")));
    mockSpawn.mockReturnValue(proc);

    const errors: LintReport["engineErrors"] = [];
    const findings = await runLibraryCli("/project", errors);
    expect(findings).toHaveLength(0);
    expect(errors[0].engine).toBe("library");
  });

  it("records engineError and returns [] on malformed JSON output", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess("not json", 0));
    const errors: LintReport["engineErrors"] = [];
    const findings = await runLibraryCli("/project", errors);
    expect(findings).toHaveLength(0);
    expect(errors[0].message).toMatch(/parse/i);
  });

  it("returns [] on empty stdout without recording an error", async () => {
    mockSpawn.mockReturnValue(makeFakeProcess("", 0));
    const errors: LintReport["engineErrors"] = [];
    const findings = await runLibraryCli("/project", errors);
    expect(findings).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("degrades gracefully when the claudelint bin cannot be resolved", async () => {
    // Simulate a bin-resolution failure (e.g. bundler rewriting the dynamic
    // require.resolve, or the package being absent). The wrapper must honor
    // its degrade-don't-throw contract: record an engineError, return [], and
    // never spawn — not throw synchronously and 500 the whole scan.
    const dirnameSpy = vi
      .spyOn(path, "dirname")
      .mockImplementation(() => { throw new Error("bin resolve failed"); });
    const errors: LintReport["engineErrors"] = [];
    const findings = await runLibraryCli("/project", errors);
    expect(findings).toHaveLength(0);
    expect(errors[0].engine).toBe("library");
    expect(errors[0].message).toMatch(/resolve claudelint bin/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    dirnameSpy.mockRestore();
  });
});
