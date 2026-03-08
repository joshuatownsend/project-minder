import { exec } from "child_process";
import { promisify } from "util";
import { GitInfo } from "../types";

const execAsync = promisify(exec);

async function runGit(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { cwd, timeout: 2000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function scanGit(projectPath: string): Promise<GitInfo | undefined> {
  // Use a single git command to get branch + last commit info
  // Avoid `git status` entirely — it's extremely slow on Windows with many repos
  const branch = await runGit("git branch --show-current", projectPath);
  if (!branch) return undefined;

  const logLine = await runGit(
    'git log -1 --format="%aI|||%s"',
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

  return {
    branch,
    lastCommitDate,
    lastCommitMessage,
    isDirty: false,
    uncommittedCount: 0,
  };
}
