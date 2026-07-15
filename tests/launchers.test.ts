import { describe, it, expect } from "vitest";
import {
  LAUNCHER_WORKFLOWS,
  buildWorkflowDispatch,
  buildSkillDispatch,
  selectSkillChips,
  MAX_SKILL_CHIPS,
  type LauncherWorkflow,
} from "@/lib/launchers/definitions";
import { EXECUTION_MODES, RISK_LEVELS } from "@/lib/tasks/types";

// ---------------------------------------------------------------------------
// Curated definitions integrity
// ---------------------------------------------------------------------------

describe("LAUNCHER_WORKFLOWS", () => {
  it("has a non-trivial curated gallery", () => {
    expect(LAUNCHER_WORKFLOWS.length).toBeGreaterThanOrEqual(4);
  });

  it("every workflow has unique id, icon, label, and a substantive prompt", () => {
    const ids = new Set<string>();
    for (const wf of LAUNCHER_WORKFLOWS) {
      expect(wf.id).toBeTruthy();
      expect(ids.has(wf.id)).toBe(false);
      ids.add(wf.id);
      expect(wf.icon).toBeTruthy();
      expect(wf.label.trim()).toBeTruthy();
      // Prompts are self-contained (no chat history) so they must carry real
      // instruction, not a one-liner.
      expect(wf.prompt.length).toBeGreaterThan(40);
    }
  });

  it("uses only valid execution_mode / risk_level enum values when set", () => {
    for (const wf of LAUNCHER_WORKFLOWS) {
      if (wf.execution_mode !== undefined) {
        expect((EXECUTION_MODES as readonly string[]).includes(wf.execution_mode)).toBe(true);
      }
      if (wf.risk_level !== undefined) {
        expect((RISK_LEVELS as readonly string[]).includes(wf.risk_level)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildWorkflowDispatch
// ---------------------------------------------------------------------------

describe("buildWorkflowDispatch", () => {
  const wf: LauncherWorkflow = {
    id: "demo-wf",
    icon: "🧪",
    label: "Test & fix",
    description: "desc",
    prompt: "Run the suite and fix failures. This is a sufficiently long prompt.",
    risk_level: "medium",
  };

  it("maps label→title, prompt→description, and stamps project cwd metadata", () => {
    const d = buildWorkflowDispatch(wf, "C:\\dev\\minder");
    expect(d.title).toBe("Test & fix");
    expect(d.description).toBe(wf.prompt);
    expect(d.risk_level).toBe("medium");
    expect(d.metadata).toEqual({
      projectPath: "C:\\dev\\minder",
      source: "workflow-launcher",
      launcherId: "demo-wf",
    });
  });

  it("produces a dispatch for each shipped workflow", () => {
    for (const w of LAUNCHER_WORKFLOWS) {
      const d = buildWorkflowDispatch(w, "C:\\dev\\x");
      expect(d.metadata.launcherId).toBe(w.id);
      expect(d.metadata.projectPath).toBe("C:\\dev\\x");
    }
  });
});

// ---------------------------------------------------------------------------
// buildSkillDispatch
// ---------------------------------------------------------------------------

describe("buildSkillDispatch", () => {
  it("dispatches the bare /slug invocation with a skill: launcherId", () => {
    // Display name differs from the slug — the invocation must use the slug
    // (the real slash token), not the prose name ("/Code Review" is invalid).
    const d = buildSkillDispatch({ slug: "code-review", name: "Code Review" }, "C:\\dev\\minder");
    expect(d.title).toBe("/code-review");
    expect(d.description).toBe("/code-review");
    expect(d.metadata.launcherId).toBe("skill:code-review");
    expect(d.metadata.projectPath).toBe("C:\\dev\\minder");
    expect(d.metadata.source).toBe("workflow-launcher");
  });
});

// ---------------------------------------------------------------------------
// selectSkillChips
// ---------------------------------------------------------------------------

describe("selectSkillChips", () => {
  const rows = [
    { entry: { slug: "b-skill", name: "b-skill", userInvocable: true } },
    { entry: { slug: "a-skill", name: "a-skill", userInvocable: true } },
    { entry: { slug: "auto-only", name: "auto-only", userInvocable: false } }, // excluded
    { entry: { slug: "disabled", name: "disabled", userInvocable: true, disabled: true } }, // excluded
    { entry: undefined }, // no entry — excluded
    { entry: { slug: "", name: "", userInvocable: true } }, // empty ids — excluded
  ];

  it("keeps only user-invocable, non-disabled skills with ids, sorted by name", () => {
    const chips = selectSkillChips(rows);
    expect(chips.map((c) => c.slug)).toEqual(["a-skill", "b-skill"]);
  });

  it("caps the result at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      entry: { slug: `s${String(i).padStart(2, "0")}`, name: `s${String(i).padStart(2, "0")}`, userInvocable: true },
    }));
    expect(selectSkillChips(many).length).toBe(MAX_SKILL_CHIPS);
    expect(selectSkillChips(many, 3).length).toBe(3);
  });

  it("returns an empty array when nothing qualifies (curated chips still render)", () => {
    expect(selectSkillChips([{ entry: { slug: "x", name: "x", userInvocable: false } }])).toEqual([]);
  });
});
