export type ErrorCategory =
  | "permission"
  | "timeout"
  | "not-found"
  | "parse"
  | "network"
  | "interrupted"
  | "other";

interface CategoryRule {
  category: ErrorCategory;
  patterns: RegExp[];
}

const RULES: CategoryRule[] = [
  {
    category: "permission",
    patterns: [
      /permission denied/i,
      /access denied/i,
      /EACCES/,
      /not allowed/i,
      /forbidden/i,
      /unauthorized/i,
      /read-?only/i,
    ],
  },
  {
    category: "timeout",
    patterns: [
      /timed? ?out/i,
      /ETIMEDOUT/,
      /deadline exceeded/i,
      /took too long/i,
      /exceeded.*time limit/i,
    ],
  },
  {
    category: "not-found",
    patterns: [
      /no such file/i,
      /file not found/i,
      /ENOENT/,
      /not found/i,
      /does not exist/i,
      /cannot find/i,
      /could not find/i,
    ],
  },
  {
    category: "parse",
    patterns: [
      /syntax error/i,
      /parse error/i,
      /invalid json/i,
      /unexpected token/i,
      /failed to parse/i,
      /malformed/i,
    ],
  },
  {
    category: "network",
    patterns: [
      /ECONNREFUSED/,
      /ENOTFOUND/,
      /ECONNRESET/,
      /network error/i,
      /connection refused/i,
      /failed to fetch/i,
      /socket hang up/i,
      /getaddrinfo/i,
    ],
  },
  {
    category: "interrupted",
    patterns: [
      /interrupted/i,
      /aborted/i,
      /cancelled/i,
      /SIGINT/,
      /SIGTERM/,
      /process exited/i,
    ],
  },
];

export function categorizeToolError(content: string): ErrorCategory {
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(content)) return rule.category;
    }
  }
  return "other";
}
