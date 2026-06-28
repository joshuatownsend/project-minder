/**
 * Pure parser that extracts `{owner, repo}` from a git remote URL, returning
 * `null` for anything that isn't a `github.com` HTTPS/SSH remote.
 *
 * Security-critical (Portfolio Command Deck — Phase 4): the returned
 * owner/repo are validated against `^[A-Za-z0-9._-]+$` so the result is safe
 * to pass to `execFile("gh", ["-R", `${owner}/${repo}`])` as an array arg —
 * a malformed remote can't smuggle a flag or a shell metacharacter (P2). The
 * value is never interpolated into a shell; `execFile` bypasses the shell
 * entirely and this regex is belt-and-suspenders.
 */

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

// One path segment of a GitHub owner/repo: letters, digits, dot, underscore,
// hyphen. Deliberately rejects `/`, `:`, whitespace, and shell metacharacters.
const SEG = "[A-Za-z0-9._-]+";
const SEG_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Accepts:
 *   - https://github.com/owner/repo(.git)(/)
 *   - http://github.com/owner/repo(.git)(/)
 *   - git@github.com:owner/repo(.git)(/)   (SCP-style)
 *   - ssh://git@github.com/owner/repo(.git)(/)
 * Returns `null` for non-github.com hosts (GitLab/Bitbucket/etc.), bare paths,
 * empty/undefined input, and any segment containing a slash/colon/space.
 */
export function parseGitHubRemote(
  remoteUrl: string | undefined | null
): GithubRepoRef | null {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim();
  if (!url) return null;

  const https = url.match(
    new RegExp(`^https?://github\\.com/(${SEG})/(${SEG})(?:\\.git)?/?$`)
  );
  const sshScp = url.match(
    new RegExp(`^git@github\\.com:(${SEG})/(${SEG})(?:\\.git)?/?$`)
  );
  const sshUrl = url.match(
    new RegExp(`^ssh://git@github\\.com/(${SEG})/(${SEG})(?:\\.git)?/?$`)
  );

  const m = https ?? sshScp ?? sshUrl;
  if (!m) return null;

  const owner = m[1];
  const repo = (m[2] ?? "").replace(/\.git$/, "");
  if (!owner || !repo) return null;

  // Belt-and-suspenders: reject anything the capture groups shouldn't allow.
  if (!SEG_RE.test(owner) || !SEG_RE.test(repo)) return null;

  return { owner, repo };
}
