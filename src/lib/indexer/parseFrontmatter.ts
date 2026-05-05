import yaml from "js-yaml";

export interface ParsedFrontmatter {
  fm: Record<string, unknown>;
  body: string;
  warnings: string[];
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  // Require "---\n" so a bare horizontal rule isn't treated as frontmatter
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fm: {}, body: text, warnings: [] };
  }

  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { fm: {}, body: text, warnings: ["Frontmatter opened with --- but has no closing ---"] };
  }

  const yamlText = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();

  try {
    const parsed = yaml.load(yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { fm: parsed as Record<string, unknown>, body, warnings: [] };
    }
    if (parsed === null || parsed === undefined) {
      return { fm: {}, body, warnings: [] };
    }
    return { fm: {}, body, warnings: ["Frontmatter YAML parsed to a non-object value"] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { fm: {}, body, warnings: [`YAML parse error: ${msg}`] };
  }
}
