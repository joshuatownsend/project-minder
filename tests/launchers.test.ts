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
  it("dispatches the bare /slug invocation exactly once (title only, no description)", () => {
    // Display name differs from the slug — the invocation must use the slug
    // (the real slash token), not the prose name ("/Code Review" is invalid).
    const d = buildSkillDispatch({ slug: "code-review", name: "Code Review" }, "C:\\dev\\minder");
    expect(d.title).toBe("/code-review");
    // description is omitted so buildPrompt (title + description) doesn't send
    // "/code-review\n\n/code-review" and invoke the skill twice.
    expect(d.description).toBeUndefined();
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
    { entry: { slug: "b-skill", name: "b-skill", userInvocable: true, source: "user" } },
    { entry: { slug: "a-skill", name: "a-skill", userInvocable: true, source: "plugin" } },
    { entry: { slug: "auto-only", name: "auto-only", userInvocable: false } }, // excluded
    { entry: { slug: "disabled", name: "disabled", userInvocable: true, disabled: true } }, // excluded
    { entry: { slug: "proj-local", name: "proj-local", userInvocable: true, source: "project" } }, // excluded (project-local)
    { entry: undefined }, // no entry — excluded
    { entry: { slug: "", name: "", userInvocable: true } }, // empty ids — excluded
  ];

  it("keeps only user-invocable, non-disabled, non-project skills with ids, sorted by slug", () => {
    const chips = selectSkillChips(rows);
    expect(chips.map((c) => c.slug)).toEqual(["a-skill", "b-skill"]);
  });

  it("excludes project-local skills (they can't resolve from another project's cwd)", () => {
    const only = selectSkillChips([
      { entry: { slug: "deploy", name: "deploy", userInvocable: true, source: "project" } },
    ]);
    expect(only).toEqual([]);
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

  // Issue #405. The catalog indexes every cached copy of a plugin, and the
  // cache retains old versions and mirrors the same plugin across
  // marketplaces. Measured on the reference machine: 1,122 plugin skill
  // directories, 201 distinct slugs — `ai-gateway` three times, `neon` 57.
  // Undeduplicated they render as identical chips with identical
  // `skill:<slug>` React keys.
  it("collapses a slug cached under several plugin versions to one chip", () => {
    const chips = selectSkillChips([
      { entry: { slug: "ai-gateway", name: "AI Gateway", userInvocable: true, source: "plugin" } },
      { entry: { slug: "ai-gateway", name: "AI Gateway", userInvocable: true, source: "plugin" } },
      { entry: { slug: "ai-gateway", name: "AI Gateway", userInvocable: true, source: "plugin" } },
    ]);
    expect(chips.map((c) => c.slug)).toEqual(["ai-gateway"]);
  });

  // The only collision where the surviving record differs in substance: the
  // dispatch is `/<slug>` either way, but the tooltip should come from the
  // skill the developer installed themselves.
  //
  // Asserted in BOTH input orders on purpose. With only the plugin-first case,
  // a "keep whichever came last" implementation passes — mutation-testing this
  // file caught exactly that, since keep-last happens to agree with precedence
  // when the user copy is second.
  it.each([
    ["plugin first", ["plugin", "user"]],
    ["user first", ["user", "plugin"]],
  ] as const)("prefers the user-scope copy over a plugin's (%s)", (_label, order) => {
    const chips = selectSkillChips(
      order.map((source) => ({
        entry: {
          slug: "remember",
          name: source === "user" ? "User copy" : "Plugin copy",
          description: `from ${source}`,
          userInvocable: true,
          source,
        },
      })),
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].name).toBe("User copy");
    expect(chips[0].description).toBe("from user");
  });

  it("deduplicates before applying the cap, so repeats cannot spend slots", () => {
    // The user-visible harm: with the cap consumed by copies of one skill, the
    // distinct skills below it never render at all.
    const dupes = Array.from({ length: 20 }, () => ({
      entry: { slug: "aaa-dup", name: "aaa-dup", userInvocable: true, source: "plugin" },
    }));
    const distinct = Array.from({ length: 5 }, (_, i) => ({
      entry: { slug: `zz-${i}`, name: `zz-${i}`, userInvocable: true, source: "plugin" },
    }));
    const chips = selectSkillChips([...dupes, ...distinct], 4);
    expect(chips.map((c) => c.slug)).toEqual(["aaa-dup", "zz-0", "zz-1", "zz-2"]);
  });

  it("gives every chip a unique React key", () => {
    // The reported symptom, asserted directly: `LauncherChips` keys on
    // `skill:${slug}`, and React's documented behaviour for duplicate keys is
    // duplication and/or omission of children.
    const chips = selectSkillChips([
      { entry: { slug: "dup", name: "dup", userInvocable: true, source: "plugin" } },
      { entry: { slug: "dup", name: "dup", userInvocable: true, source: "plugin" } },
      { entry: { slug: "other", name: "other", userInvocable: true, source: "user" } },
    ]);
    const keys = chips.map((c) => `skill:${c.slug}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
