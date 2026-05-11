import yaml from "js-yaml";
import type { MemoryType } from "../types";

// Claude Code memory files use YAML frontmatter to declare type + description.
// The prefix on the basename is load-bearing per Bustamante's article: the
// model treats `feedback_*` as binding overrides, `reference_*` as sticky
// facts, `project_*` as project-scoped, `user_*` as user description. The
// prefix and the `type` field MUST agree -- a `feedback_x.md` with
// `type: reference` would lie to the model. This module parses the
// frontmatter, validates the prefix-type contract, and is used both by the
// seed generator (output validation) and the memory writer (write-time
// guard) so the bad path never reaches disk.

export interface MemoryFrontmatter {
  name?: string;
  description?: string;
  type?: MemoryType;
  derived_from?: string[];
  seeded?: boolean;
  [key: string]: unknown;
}

export type FrontmatterError =
  | { code: "INVALID_YAML"; message: string }
  | { code: "INVALID_TYPE"; given: string }
  | { code: "PREFIX_TYPE_MISMATCH"; prefix: string; type: MemoryType }
  | { code: "UNKNOWN_PREFIX"; basename: string };

export interface ParsedFrontmatter {
  data: MemoryFrontmatter;
  body: string;
  raw: string;
}

// Closing `---` is followed by *at least one* newline plus any additional
// blank lines, so the body slice doesn't include the gap most authors leave
// between frontmatter and body. Without this, round-tripping through
// composeMemoryFile would add a stray leading blank line on every write.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)+/;

export function parseFrontmatter(
  content: string,
): ParsedFrontmatter | { error: FrontmatterError } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { data: {}, body: content, raw: "" };
  const raw = match[1];
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      error: {
        code: "INVALID_YAML",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  const data: MemoryFrontmatter =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as MemoryFrontmatter)
      : {};
  return { data, body: content.slice(match[0].length), raw };
}

const ALLOWED_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];
const PREFIX_BY_TYPE: Record<MemoryType, string> = {
  user: "user_",
  feedback: "feedback_",
  project: "project_",
  reference: "reference_",
};

const TYPE_BY_PREFIX: Record<string, MemoryType> = {
  user_: "user",
  feedback_: "feedback",
  project_: "project",
  reference_: "reference",
};

function basenamePrefix(basename: string): string | null {
  for (const prefix of Object.keys(TYPE_BY_PREFIX)) {
    if (basename.toLowerCase().startsWith(prefix)) return prefix;
  }
  return null;
}

export function validateTypedMemory(
  basename: string,
  data: MemoryFrontmatter,
): FrontmatterError | null {
  // MEMORY.md is the index file, not a typed body -- exempt.
  if (basename.toLowerCase() === "memory.md") return null;
  const prefix = basenamePrefix(basename);
  if (!prefix) {
    // Untyped basenames are tolerated UNLESS the frontmatter declares a
    // type -- then the prefix-as-cue contract is silently broken.
    if (data.type && ALLOWED_TYPES.includes(data.type)) {
      return { code: "UNKNOWN_PREFIX", basename };
    }
    return null;
  }
  const inferredType = TYPE_BY_PREFIX[prefix];
  if (data.type === undefined) return null;
  if (!ALLOWED_TYPES.includes(data.type)) {
    return { code: "INVALID_TYPE", given: String(data.type) };
  }
  if (data.type !== inferredType) {
    return { code: "PREFIX_TYPE_MISMATCH", prefix, type: data.type };
  }
  return null;
}

export function composeMemoryFile(data: MemoryFrontmatter, body: string): string {
  const yamlStr = yaml.dump(data, { lineWidth: 100, noRefs: true });
  return `---\n${yamlStr.trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
}

export { ALLOWED_TYPES, PREFIX_BY_TYPE };
