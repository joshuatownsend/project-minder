import yaml from "js-yaml";

export interface ParsedFrontmatter {
  fm: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  // Require "---\n" so a bare horizontal rule isn't treated as frontmatter
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fm: {}, body: text };
  }

  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { fm: {}, body: text };
  }

  const yamlText = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();

  try {
    const parsed = yaml.load(yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { fm: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Malformed YAML (embedded XML, unescaped colons, etc.) — return empty fm
  }

  return { fm: {}, body };
}
