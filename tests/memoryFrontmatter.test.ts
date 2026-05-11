import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  validateTypedMemory,
  composeMemoryFile,
} from "@/lib/memory/memoryFrontmatter";

describe("parseFrontmatter", () => {
  it("returns empty data and full body when there is no frontmatter", () => {
    const out = parseFrontmatter("just markdown\nno frontmatter\n");
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(out.data).toEqual({});
      expect(out.body).toBe("just markdown\nno frontmatter\n");
    }
  });

  it("parses well-formed YAML frontmatter", () => {
    const content = `---
name: user role
description: who the user is
type: user
---

body text here
`;
    const out = parseFrontmatter(content);
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(out.data.name).toBe("user role");
      expect(out.data.description).toBe("who the user is");
      expect(out.data.type).toBe("user");
      expect(out.body).toBe("body text here\n");
    }
  });

  it("preserves unknown fields (derived_from, seeded) through round-trip", () => {
    const original = composeMemoryFile(
      {
        name: "seeded",
        description: "x",
        type: "user",
        derived_from: ["a.md", "b.md"],
        seeded: true,
      },
      "body\n",
    );
    const out = parseFrontmatter(original);
    if ("error" in out) throw new Error("unexpected error");
    expect(out.data.derived_from).toEqual(["a.md", "b.md"]);
    expect(out.data.seeded).toBe(true);
  });

  it("returns INVALID_YAML when the frontmatter block can't be parsed", () => {
    const content = `---
name: [unclosed bracket
---

body
`;
    const out = parseFrontmatter(content);
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error.code).toBe("INVALID_YAML");
    }
  });

  it("handles CRLF line endings in the frontmatter delimiter", () => {
    const content = "---\r\ntype: user\r\n---\r\n\r\nbody\r\n";
    const out = parseFrontmatter(content);
    expect("error" in out).toBe(false);
    if (!("error" in out)) expect(out.data.type).toBe("user");
  });
});

describe("validateTypedMemory", () => {
  it("exempts MEMORY.md from the prefix contract", () => {
    expect(validateTypedMemory("MEMORY.md", { type: "user" })).toBeNull();
    expect(validateTypedMemory("memory.md", {})).toBeNull();
  });

  it("returns null when basename prefix matches type", () => {
    expect(validateTypedMemory("user_role.md", { type: "user" })).toBeNull();
    expect(validateTypedMemory("feedback_x.md", { type: "feedback" })).toBeNull();
    expect(validateTypedMemory("project_foo.md", { type: "project" })).toBeNull();
    expect(validateTypedMemory("reference_y.md", { type: "reference" })).toBeNull();
  });

  it("returns PREFIX_TYPE_MISMATCH when prefix disagrees with declared type", () => {
    const err = validateTypedMemory("feedback_x.md", { type: "reference" });
    expect(err?.code).toBe("PREFIX_TYPE_MISMATCH");
    if (err?.code === "PREFIX_TYPE_MISMATCH") {
      expect(err.prefix).toBe("feedback_");
      expect(err.type).toBe("reference");
    }
  });

  it("returns INVALID_TYPE for an unknown type value", () => {
    const err = validateTypedMemory("user_role.md", { type: "garbage" as never });
    expect(err?.code).toBe("INVALID_TYPE");
  });

  it("returns UNKNOWN_PREFIX when basename has no typed prefix but frontmatter declares a type", () => {
    const err = validateTypedMemory("notes.md", { type: "user" });
    expect(err?.code).toBe("UNKNOWN_PREFIX");
  });

  it("tolerates typed prefix with no type declared (no contract to enforce)", () => {
    expect(validateTypedMemory("user_role.md", {})).toBeNull();
  });

  it("tolerates untyped basename with no type declared", () => {
    expect(validateTypedMemory("notes.md", {})).toBeNull();
  });

  it("is case-insensitive on the prefix", () => {
    expect(validateTypedMemory("USER_role.md", { type: "user" })).toBeNull();
  });
});

describe("composeMemoryFile", () => {
  it("produces a parseable round-trip", () => {
    const composed = composeMemoryFile({ type: "user", name: "x" }, "body\n");
    const parsed = parseFrontmatter(composed);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.data.type).toBe("user");
      expect(parsed.body).toBe("body\n");
    }
  });

  it("strips leading newlines from the body to avoid blank-line drift", () => {
    const composed = composeMemoryFile({ type: "user" }, "\n\nbody\n");
    expect(composed).toMatch(/---\n\nbody\n$/);
  });
});
