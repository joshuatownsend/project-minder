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
export async function scanGitDirtyStatus(
  projectPath: string
): Promise<{ isDirty: boolean; uncommittedCount: number }> {
  const porcelain = await runGit(["status", "--porcelain"], projectPath);
  if (!porcelain) return { isDirty: false, uncommittedCount: 0 };
  const lines = porcelain.split("\n").filter((l) => l.trim());
  return { isDirty: lines.length > 0, uncommittedCount: lines.length };
}
