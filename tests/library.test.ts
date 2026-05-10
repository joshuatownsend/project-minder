import { describe, it, expect } from "vitest";
import { LIBRARY, STACK_PRESETS } from "@/lib/template/library";

describe("LIBRARY index", () => {
  it("has at least one item per kind", () => {
    const kinds = new Set(LIBRARY.map((i) => i.kind));
    expect(kinds.has("command")).toBe(true);
    expect(kinds.has("skill")).toBe(true);
    expect(kinds.has("agent")).toBe(true);
  });

  it("each item has a unique id", () => {
    const ids = LIBRARY.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each item id matches <kind>/<slug>", () => {
    for (const item of LIBRARY) {
      expect(item.id).toBe(`${item.kind}/${item.slug}`);
    }
  });

  it("each item has non-empty required fields", () => {
    for (const item of LIBRARY) {
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.slug.length).toBeGreaterThan(0);
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.content.length).toBeGreaterThan(0);
      expect(item.tags.length).toBeGreaterThan(0);
      expect(item.stacks.length).toBeGreaterThan(0);
    }
  });

  it("each item kind is agent, skill, or command", () => {
    const valid = new Set(["agent", "skill", "command"]);
    for (const item of LIBRARY) {
      expect(valid.has(item.kind)).toBe(true);
    }
  });

  it("each item content starts with YAML frontmatter", () => {
    for (const item of LIBRARY) {
      expect(item.content.trimStart()).toMatch(/^---\n/);
    }
  });
});

describe("STACK_PRESETS", () => {
  it("covers all four stacks", () => {
    for (const stack of ["typescript", "python", "go", "rust"]) {
      expect(STACK_PRESETS[stack]).toBeDefined();
      expect((STACK_PRESETS[stack] ?? []).length).toBeGreaterThan(0);
    }
  });

  it("each preset id references an existing library item", () => {
    const ids = new Set(LIBRARY.map((i) => i.id));
    for (const [stack, preset] of Object.entries(STACK_PRESETS)) {
      for (const id of preset) {
        expect(ids.has(id), `Stack "${stack}" preset references unknown id "${id}"`).toBe(true);
      }
    }
  });
});
