import { describe, it, expect } from "vitest";
import { LIBRARY, STACK_PRESETS } from "@/lib/template/library";

/**
 * Tests for the new-project wizard's logic (stack presets, library integration).
 * The route handler itself exercises bootstrapNewProject which has its own integration
 * concerns; here we verify the static data assumptions the wizard relies on.
 */

describe("stack preset → library item mapping", () => {
  it("typescript preset selects at least a reviewer and test-writer", () => {
    const ids = new Set(STACK_PRESETS.typescript ?? []);
    const hasReviewer = [...ids].some((id) => id.includes("reviewer"));
    const hasTesting = [...ids].some((id) => id.includes("test"));
    expect(hasReviewer).toBe(true);
    expect(hasTesting).toBe(true);
  });

  it("python preset selects at least a reviewer", () => {
    const ids = new Set(STACK_PRESETS.python ?? []);
    expect([...ids].some((id) => id.includes("reviewer"))).toBe(true);
  });

  it("go preset selects at least a reviewer", () => {
    const ids = new Set(STACK_PRESETS.go ?? []);
    expect([...ids].some((id) => id.includes("reviewer"))).toBe(true);
  });

  it("rust preset selects at least a reviewer", () => {
    const ids = new Set(STACK_PRESETS.rust ?? []);
    expect([...ids].some((id) => id.includes("reviewer"))).toBe(true);
  });

  it("all stack presets include the /review command", () => {
    for (const [stack, preset] of Object.entries(STACK_PRESETS)) {
      if (stack === "generic") continue;
      expect(preset, `${stack} preset`).toContain("command/review");
    }
  });
});

describe("library item apply path derivation", () => {
  it("agents map to .claude/agents/<slug>.md", () => {
    const agents = LIBRARY.filter((i) => i.kind === "agent");
    for (const a of agents) {
      const expectedPath = `.claude/agents/${a.slug}.md`;
      // Just validate slug doesn't contain path separators
      expect(a.slug).not.toContain("/");
      expect(a.slug).not.toContain("\\");
      expect(expectedPath).toMatch(/^\.claude\/agents\/.+\.md$/);
    }
  });

  it("skills map to .claude/skills/<slug>.md", () => {
    const skills = LIBRARY.filter((i) => i.kind === "skill");
    for (const s of skills) {
      expect(s.slug).not.toContain("/");
      expect(`.claude/skills/${s.slug}.md`).toMatch(/^\.claude\/skills\/.+\.md$/);
    }
  });

  it("skill apply key includes :standalone layout suffix", () => {
    const skills = LIBRARY.filter((i) => i.kind === "skill");
    for (const s of skills) {
      const key = `${s.slug}:standalone`;
      expect(key).toMatch(/^[a-z0-9-]+:standalone$/);
    }
  });

  it("commands map to .claude/commands/<slug>.md", () => {
    const commands = LIBRARY.filter((i) => i.kind === "command");
    for (const c of commands) {
      expect(c.slug).not.toContain("/");
      expect(`.claude/commands/${c.slug}.md`).toMatch(/^\.claude\/commands\/.+\.md$/);
    }
  });
});
