import yaml from "js-yaml";
import { parseFrontmatter as parseFmIndexer } from "../indexer/parseFrontmatter";
import type { MemoryType } from "../types";

// Owns the prefix↔type contract for typed memory files: `feedback_*` must
// declare `type: feedback`, etc. YAML parsing itself delegates to the
// shared indexer parser (used by agents/skills/commands catalog discovery)
// -- we just promote its warnings to hard errors so the writer rejects
// malformed YAML instead of silently dropping the frontmatter.

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
}

export function parseFrontmatter(
  content: string,
): ParsedFrontmatter | { error: FrontmatterError } {
  const result = parseFmIndexer(content);
  if (result.warnings.length > 0) {
    return { error: { code: "INVALID_YAML", message: result.warnings[0] } };
  }
  return { data: result.fm as MemoryFrontmatter, body: result.body };
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
