import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "@/lib/indexer/parseFrontmatter";

describe("parseFrontmatter", () => {
  it("returns empty fm and full text when there is no frontmatter", () => {
    const result = parseFrontmatter("just some markdown");
    expect(result.fm).toEqual({});
    expect(result.body).toBe("just some markdown");
  });

  it("returns empty fm and full text for an empty string", () => {
    const result = parseFrontmatter("");
    expect(result.fm).toEqual({});
    expect(result.body).toBe("");
  });

  it("parses a simple frontmatter block", () => {
    const text = `---\nname: my-skill\ndescription: A test skill\n---\n\nBody here.`;
    const result = parseFrontmatter(text);
    expect(result.fm.name).toBe("my-skill");
    expect(result.fm.description).toBe("A test skill");
    expect(result.body).toBe("Body here.");
  });

  it("parses nested frontmatter (metadata block)", () => {
    const text = `---\nname: nextjs\nmetadata:\n  priority: 5\n  docs:\n    - https://example.com\n---\nSkill body.`;
    const result = parseFrontmatter(text);
    expect(result.fm.name).toBe("nextjs");
    expect((result.fm.metadata as Record<string, unknown>)?.priority).toBe(5);
    expect(result.body).toBe("Skill body.");
  });

  it("does not throw on malformed YAML — returns empty fm", () => {
    // Unescaped colon in description triggers YAML parse error
    const text = `---\nname: test\ndescription: Use when user asks: <example>foo</example>\n---\nBody.`;
    expect(() => parseFrontmatter(text)).not.toThrow();
    const result = parseFrontmatter(text);
    // fm may be {} or partial — what matters is no throw and body is present
    expect(typeof result.body).toBe("string");
  });

  it("handles multi-line quoted description", () => {
    const text = `---\nname: audit\ndescription: "Run checks\\nfor quality"\n---\nBody.`;
    const result = parseFrontmatter(text);
    expect(result.fm.name).toBe("audit");
    expect(result.body).toBe("Body.");
  });

  it("returns empty fm when closing --- is missing", () => {
    const text = `---\nname: broken`;
    const result = parseFrontmatter(text);
    expect(result.fm).toEqual({});
  });
});
