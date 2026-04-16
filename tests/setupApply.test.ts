import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { applySetup } from "@/lib/setupApply";
import {
  CLAUDE_MD_TODO_BLOCK,
  CLAUDE_MD_MANUAL_STEPS_BLOCK,
} from "@/lib/setup-content";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-apply-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── CLAUDE.md ────────────────────────────────────────────────────────────────

describe("applySetup — claude-md", () => {
  it("creates CLAUDE.md with both blocks when file does not exist", async () => {
    const result = await applySetup(tmpDir, "claude-md");

    expect(result.claudeMd).toEqual({ todo: "applied", manualSteps: "applied" });

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("## TODO");
    expect(content).toContain("## Manual Step Logging");
    expect(content.startsWith("# CLAUDE.md")).toBe(true);
  });

  it("returns already-present for both when both sentinels are present", async () => {
    const existing = `# Project\n\n${CLAUDE_MD_TODO_BLOCK}\n\n${CLAUDE_MD_MANUAL_STEPS_BLOCK}\n`;
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), existing, "utf-8");

    const result = await applySetup(tmpDir, "claude-md");

    expect(result.claudeMd).toEqual({
      todo: "already-present",
      manualSteps: "already-present",
    });

    // File should be unchanged
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toBe(existing);
  });

  it("appends only the missing manual-steps block when TODO is already present", async () => {
    const existing = `# Project\n\n${CLAUDE_MD_TODO_BLOCK}\n`;
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), existing, "utf-8");

    const result = await applySetup(tmpDir, "claude-md");

    expect(result.claudeMd).toEqual({
      todo: "already-present",
      manualSteps: "applied",
    });

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("## Manual Step Logging");
    // Backup should have been created
    const backup = await fs.readFile(path.join(tmpDir, "CLAUDE.md.minder-bak"), "utf-8");
    expect(backup).toBe(existing);
  });

  it("appends only the missing TODO block when manual-steps is already present", async () => {
    const existing = `# Project\n\n${CLAUDE_MD_MANUAL_STEPS_BLOCK}\n`;
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), existing, "utf-8");

    const result = await applySetup(tmpDir, "claude-md");

    expect(result.claudeMd).toEqual({
      todo: "applied",
      manualSteps: "already-present",
    });

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("## TODO");
  });

  it("appends both blocks to an empty CLAUDE.md", async () => {
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "", "utf-8");

    const result = await applySetup(tmpDir, "claude-md");

    expect(result.claudeMd).toEqual({ todo: "applied", manualSteps: "applied" });

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("## TODO");
    expect(content).toContain("## Manual Step Logging");
  });
});

// ─── Hooks ────────────────────────────────────────────────────────────────────

describe("applySetup — hooks", () => {
  it("creates .claude/hooks dir, writes both scripts, and creates settings.local.json", async () => {
    const result = await applySetup(tmpDir, "hooks");

    expect(result.hooks).toEqual({
      settingsJson: "applied",
      validateTodo: "applied",
      validateManualSteps: "applied",
    });

    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const todoScript = await fs.readFile(
      path.join(hooksDir, "validate-todo-format.mjs"),
      "utf-8"
    );
    expect(todoScript.length).toBeGreaterThan(0);

    const msScript = await fs.readFile(
      path.join(hooksDir, "validate-manual-steps.mjs"),
      "utf-8"
    );
    expect(msScript.length).toBeGreaterThan(0);

    const settings = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8")
    );
    const commands: string[] = settings.hooks.PreToolUse.flatMap(
      (e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command)
    );
    expect(commands.some((c) => c.includes("validate-todo-format.mjs"))).toBe(true);
    expect(commands.some((c) => c.includes("validate-manual-steps.mjs"))).toBe(true);
  });

  it("returns already-present for all when re-applied", async () => {
    await applySetup(tmpDir, "hooks");
    const result = await applySetup(tmpDir, "hooks");

    expect(result.hooks).toEqual({
      settingsJson: "already-present",
      validateTodo: "already-present",
      validateManualSteps: "already-present",
    });
  });

  it("throws on malformed settings.local.json", async () => {
    const claudeDir = path.join(tmpDir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "settings.local.json"),
      "{ not valid json",
      "utf-8"
    );

    await expect(applySetup(tmpDir, "hooks")).rejects.toThrow(/invalid JSON/i);
  });

  it("adds only missing hook command when one is already in settings", async () => {
    const claudeDir = path.join(tmpDir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });

    // Pre-seed settings with validate-todo already present
    const preExisting = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              {
                type: "command",
                command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/validate-todo-format.mjs"`,
              },
            ],
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(claudeDir, "settings.local.json"),
      JSON.stringify(preExisting, null, 2),
      "utf-8"
    );

    const result = await applySetup(tmpDir, "hooks");

    // settingsJson applied because manual-steps was missing
    expect(result.hooks?.settingsJson).toBe("applied");

    const updated = JSON.parse(
      await fs.readFile(path.join(claudeDir, "settings.local.json"), "utf-8")
    );
    const commands: string[] = updated.hooks.PreToolUse.flatMap(
      (e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command)
    );
    expect(commands.some((c) => c.includes("validate-manual-steps.mjs"))).toBe(true);
  });
});

// ─── Both ─────────────────────────────────────────────────────────────────────

describe("applySetup — both", () => {
  it("applies claude-md and hooks together", async () => {
    const result = await applySetup(tmpDir, "both");

    expect(result.claudeMd).toBeDefined();
    expect(result.hooks).toBeDefined();
    expect(result.claudeMd?.todo).toBe("applied");
    expect(result.hooks?.settingsJson).toBe("applied");
  });
});
