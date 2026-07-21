import { execFile } from "child_process";
import { promisify } from "util";
import { GitInfo } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Waive git's `safe.directory` ownership check for Minder's own read-only
 * git calls.
 *
 * Git refuses to operate on a repository whose owner differs from the current
 * user ("detected dubious ownership"). Every project scanned over UNC —
 * notably a WSL distro at `\\wsl.localhost\<distro>\home\<user>\…` — trips
 * this, because the files carry a Linux UID. `runGit` swallows the error and
 * returns `""`, so the whole `GitInfo` came back `undefined`: no branch, no
 * remote, no dirty count, no commit history for any WSL project, silently.
 *
 * Passing `-c` scopes the waiver to a single invocation. That is strictly
 * narrower than the remedy git itself prints in the error
 * (`git config --global --add safe.directory …`), which would also apply to
 * the user's interactive shell and every other tool on the machine.
 *
 * Residual risk, accepted: `safe.directory` also guards against a repository
 * whose `.git/config` names an executable (`core.pager`, `diff.external`,
 * `core.fsmonitor`). Minder already runs these same commands against every
 * directory in the configured scan roots, so this widens the existing
 * exposure to UNC roots rather than creating a new class of it — and scan
 * roots are user-configured, not attacker-supplied.
 *
 * Prepended, not appended: `-c` is a git-level option and must precede the
 * subcommand.
 */
const SAFE_DIRECTORY_ARGS = ["-c", "safe.directory=*"];

function gitArgs(args: string[]): string[] {
  return [...SAFE_DIRECTORY_ARGS, ...args];
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", gitArgs(args), { cwd, timeout: 2000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

export interface GitExecResult {
  ok: boolean;
  stdout: string;
}

/**
 * Like `runGit`, but distinguishes an execution failure (non-zero exit,
 * timeout, git missing) from a successful call that produced no output.
 * `runGit` collapses both to `""`, which is fine for existence-style checks
 * ("does this ref exist?") but wrong for callers where "no output" is
 * itself meaningful — e.g. `git status --porcelain` returning "" legitimately
 * means "clean", but a failed exec must NOT be reported as clean (B5).
 */
export async function runGitChecked(args: string[], cwd: string): Promise<GitExecResult> {
  try {
    const { stdout } = await execFileAsync("git", gitArgs(args), { cwd, timeout: 2000 });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
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
    const { stdout } = await execFileAsync("git", gitArgs(args), {
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
  let branch = await runGit(["branch", "--show-current"], projectPath);
  if (!branch) {
    // `branch --show-current` returns "" for detached HEAD (and for a repo
    // with zero commits). Previously this discarded the entire GitInfo block
    // — commit date/message/remote — for a perfectly valid repo (B4). Fall
    // back to a short SHA as the branch label so it keeps populating.
    const shortSha = await runGit(["rev-parse", "--short", "HEAD"], projectPath);
    if (!shortSha) return undefined; // not a git repo, or no commits at all
    branch = shortSha;
  }

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

export interface GitDirtyStatus {
  isDirty: boolean;
  uncommittedCount: number;
  /**
   * True when the `git status --porcelain` invocation itself failed
   * (index.lock, timeout, git missing) rather than succeeding with no
   * output. Distinguishes "we don't know" from "confirmed clean" (B5) —
   * callers should treat this as an unknown/error state, not render it as
   * a clean repo.
   */
  unknown?: boolean;
}

export async function scanGitDirtyStatus(
  projectPath: string
): Promise<GitDirtyStatus> {
  const result = await runGitChecked(["status", "--porcelain"], projectPath);
  if (!result.ok) {
    // Exec failure — surface as unknown, NOT as clean.
    return { isDirty: false, uncommittedCount: 0, unknown: true };
  }
  if (!result.stdout) return { isDirty: false, uncommittedCount: 0 };
  const lines = result.stdout.split("\n").filter((l) => l.trim());
  return { isDirty: lines.length > 0, uncommittedCount: lines.length };
}
