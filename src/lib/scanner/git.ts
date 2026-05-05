import { execFile } from "child_process";
import { promisify } from "util";
import { GitInfo } from "../types";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Long-running git wrapper. `git log` over thousands of commits on
 * long-lived repos blows past the 2 s default in `runGit` and the 1 MB
 * default `maxBuffer`. Returns "" on any error so callers fail-soft,
 * but logs the failure to stderr — silently swallowing a timeout or
 * maxBuffer overflow would let a broken repo masquerade as one with no
 * commit history.
 */
async function runGitLong(args: string[], cwd: string, timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024, // 16 MB — enough for ~50k commits at ~300 bytes per `--format=%H|%aI|%s` line
    });
    return stdout.trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[git] runGitLong failed in ${cwd} (${args.slice(0, 2).join(" ")}…): ${reason}`);
    return "";
  }
}

/**
 * Resolve the canonical default branch for a repo: try `origin/HEAD`'s
 * symbolic-ref first (the source of truth on GitHub-cloned repos), then
 * fall back to `main`, then `master`. Returns null if none of the three
 * exist as refs — the caller should treat that as "no main detected" and
 * skip yield classification rather than guess.
 */
export async function detectMainBranch(projectPath: string): Promise<string | null> {
  // Symbolic ref: `origin/HEAD` → `origin/main` (or whatever the remote's HEAD is).
  const headRef = await runGit(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    projectPath
  );
  if (headRef && headRef.startsWith("origin/")) {
    return headRef.slice("origin/".length);
  }

  // Fallback: check `main` then `master` exist as local refs.
  for (const candidate of ["main", "master"]) {
    const sha = await runGit(["rev-parse", "--verify", `refs/heads/${candidate}`], projectPath);
    if (sha) return candidate;
  }
  return null;
}

export interface CommitMeta {
  sha: string;
  /** Author commit timestamp, ISO-8601. */
  date: string;
  /** First line of the commit message. */
  subject: string;
}

/**
 * Read commit metadata from the given branch since `sinceIso`. Callers
 * should bound `sinceIso` so long-lived repos don't dump decades of
 * history through the 16 MB maxBuffer.
 */
export async function readBranchCommits(
  projectPath: string,
  branch: string,
  sinceIso?: string
): Promise<CommitMeta[]> {
  const args = [
    "log",
    branch,
    "--first-parent",
    "--format=%H|%aI|%s",
  ];
  if (sinceIso) args.push(`--since=${sinceIso}`);

  const out = await runGitLong(args, projectPath);
  if (!out) return [];

  const commits: CommitMeta[] = [];
  for (const line of out.split("\n")) {
    const idx1 = line.indexOf("|");
    const idx2 = line.indexOf("|", idx1 + 1);
    if (idx1 === -1 || idx2 === -1) continue;
    commits.push({
      sha: line.slice(0, idx1),
      date: line.slice(idx1 + 1, idx2),
      subject: line.slice(idx2 + 1),
    });
  }
  return commits;
}

export async function scanGit(projectPath: string): Promise<GitInfo | undefined> {
  // Use a single git command to get branch + last commit info
  // Avoid `git status` entirely — it's extremely slow on Windows with many repos
  const branch = await runGit(["branch", "--show-current"], projectPath);
  if (!branch) return undefined;

  const logLine = await runGit(
    ["log", "-1", "--format=%aI|||%s"],
    projectPath
  );

  let lastCommitDate: string | undefined;
  let lastCommitMessage: string | undefined;

  if (logLine) {
    const sep = logLine.indexOf("|||");
    if (sep !== -1) {
      lastCommitDate = logLine.slice(0, sep) || undefined;
      lastCommitMessage = logLine.slice(sep + 3) || undefined;
    }
  }

  // Get remote URL and convert to HTTPS browser URL
  const rawRemote = await runGit(["remote", "get-url", "origin"], projectPath);
  let remoteUrl: string | undefined;
  if (rawRemote) {
    // Convert SSH format (git@github.com:user/repo.git) to HTTPS
    const sshMatch = rawRemote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) {
      remoteUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
    } else if (rawRemote.startsWith("https://") || rawRemote.startsWith("http://")) {
      remoteUrl = rawRemote.replace(/\.git$/, "");
    }
  }

  return {
    branch,
    lastCommitDate,
    lastCommitMessage,
    isDirty: false,
    uncommittedCount: 0,
    remoteUrl,
  };
}

/**
 * Fetch dirty status for a single project (too slow for bulk scan).
 * Call this only on detail pages.
 */
/**
 * Filters a CommitMeta array to commits whose author date falls within
 * [startMs, endMs] (inclusive). Filters in-memory — callers should pass
 * a pre-bounded result from readBranchCommits to avoid re-shelling.
 */
export function filterCommitsInInterval(
  commits: CommitMeta[],
  startMs: number,
  endMs: number
): CommitMeta[] {
  return commits.filter((c) => {
    const ms = new Date(c.date).getTime();
    return ms >= startMs && ms <= endMs;
  });
}

export async function scanGitDirtyStatus(
  projectPath: string
): Promise<{ isDirty: boolean; uncommittedCount: number }> {
  const porcelain = await runGit(["status", "--porcelain"], projectPath);
  if (!porcelain) return { isDirty: false, uncommittedCount: 0 };
  const lines = porcelain.split("\n").filter((l) => l.trim());
  return { isDirty: lines.length > 0, uncommittedCount: lines.length };
}
