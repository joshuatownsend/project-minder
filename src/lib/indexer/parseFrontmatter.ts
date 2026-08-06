import yaml from "js-yaml";

export interface ParsedFrontmatter {
  fm: Record<string, unknown>;
  body: string;
  warnings: string[];
}

/**
 * Read a frontmatter value that is meant to be a boolean.
 *
 * Claude Code accepts `yes`/`no`/`on`/`off`/`1`/`0` case-insensitively wherever
 * it accepts `true`/`false` (2.1.218), so a skill declaring
 * `user-invocable: yes` is user-invocable as far as the CLI is concerned.
 * Minder's readers compared against `true` and the literal string `"true"`, so
 * every other accepted spelling read as **false** — the skill silently vanished
 * from the launcher chips and from any filter keyed on the flag.
 *
 * The mismatch is not obvious from the YAML alone: js-yaml runs the YAML 1.2
 * core schema, where `yes`/`on` are plain strings and only `true`/`false` are
 * booleans — while `1`/`0` arrive as *numbers*. YAML 1.1 (and most people's
 * memory of it) treats all of them as booleans. So all three input types have to
 * be handled here.
 *
 * Returns `undefined` for anything unrecognised rather than coercing to
 * `false`. "Absent", "unparseable" and "explicitly off" are three different
 * states, and only the caller knows which default its field deserves.
 */
export function coerceFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "1":
      return true;
    case "false":
    case "no":
    case "off":
    case "0":
      return false;
    default:
      return undefined;
  }
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
