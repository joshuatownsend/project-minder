import { promises as fs } from "fs";
import os from "os";
import path from "path";

// Memory files routinely name source files ("see src/lib/foo.ts", "the route
// in app/api/x/route.ts is...") and those refs go stale fast -- a refactor
// renames the file but the memory does not get updated. This module surfaces
// those bad refs as a `brokenRefs` staleness reason so the user can spot
// memories that confidently point at things that no longer exist.

const EXT_PATTERN =
  "(?:ts|tsx|js|jsx|mjs|cjs|md|json|sql|yml|yaml|toml|sh|py|go|rs)";

// One char of path body (word, dot, slash, dash, @ for scoped packages, tilde
// for home-relative). Two body segments separated by `/` so `index.ts` alone
// is skipped. Lookbehind on whitespace or quote punctuation anchors at a real
// boundary; lookahead rejects partial matches like `foo.ts.bak`.
const REF_REGEX = new RegExp(
  String.raw`(?:^|[\s(\`'"])([\w@./~\-]+\/[\w@./~\-]+\.` +
    EXT_PATTERN +
    String.raw`)(?![\w./\-])`,
  "g",
);

export function extractRefCandidates(content: string): string[] {
  if (!content) return [];
  const noFences = content.replace(/```[\s\S]*?```/g, " ");
  const noUrls = noFences
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bmailto:\S+/gi, " ");
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  REF_REGEX.lastIndex = 0;
  while ((m = REF_REGEX.exec(noUrls)) !== null) {
    const candidate = m[1];
    if (/^\.\/[^/]+$/.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

interface ResolvedProjects {
  parent: string | null;
  all: string[];
}

export async function verifyRefs(
  candidates: string[],
  projects: ResolvedProjects,
  existsMemo?: Map<string, boolean>,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const broken: string[] = [];
  const ordered: (string | null)[] = projects.parent
    ? [projects.parent, ...projects.all.filter((p) => p !== projects.parent)]
    : projects.all.slice();

  for (const candidate of candidates) {
    if (await resolves(candidate, ordered, existsMemo)) continue;
    broken.push(candidate);
  }
  return broken;
}

async function resolves(
  candidate: string,
  projects: (string | null)[],
  memo: Map<string, boolean> | undefined,
): Promise<boolean> {
  if (candidate.startsWith("~/")) {
    const abs = path.join(os.homedir(), candidate.slice(2));
    return memoStat(abs, "<home>", memo, abs);
  }
  if (path.isAbsolute(candidate)) {
    return memoStat(candidate, "<abs>", memo, candidate);
  }
  for (const proj of projects) {
    if (!proj) continue;
    const abs = path.join(proj, candidate);
    if (await memoStat(abs, proj, memo, candidate)) return true;
  }
  return false;
}

async function memoStat(
  absPath: string,
  projectKey: string,
  memo: Map<string, boolean> | undefined,
  candidateKey: string,
): Promise<boolean> {
  if (memo) {
    const key = projectKey + "::" + candidateKey;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const result = await fileExists(absPath);
    memo.set(key, result);
    return result;
  }
  return fileExists(absPath);
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const s = await fs.stat(absPath);
    return s.isFile();
  } catch {
    return false;
  }
}
