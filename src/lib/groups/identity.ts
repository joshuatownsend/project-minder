/**
 * Remote normalization — the identity key for project groups.
 *
 * Two checkouts belong to the same group iff their normalized remotes match,
 * so this function *is* the operative definition of "the same project".
 * Pure and dependency-free (no fs, no Node builtins) so it can run
 * client-side alongside `deriveProjectGroups`.
 *
 * ## What the scanner already did
 *
 * The input is `git.remoteUrl`, which `src/lib/scanner/git.ts:160-172` has
 * already partially normalized:
 *
 *   - SCP-style `git@host:owner/repo.git` -> `https://host/owner/repo`
 *   - a trailing `.git` stripped from http(s) remotes
 *
 * So in the common case a Windows and a WSL checkout of the same repo arrive
 * here already byte-identical.
 *
 * ## What it did NOT do — the cases this function still has to absorb
 *
 *   - **Case is not folded.** `https://GitHub.com/Owner/Repo` arrives verbatim.
 *   - **A trailing slash is not stripped.** `https://github.com/o/r/` is possible.
 *   - **`ssh://git@host/owner/repo` and `git://…` are dropped entirely** — they
 *     match neither branch, so `remoteUrl` comes back `undefined` and such a
 *     checkout reaches us with no remote at all. That is a scanner gap, not
 *     something this function can fix; it is pinned by a test that documents
 *     the current behaviour rather than asserting the fix.
 *
 * @param remoteUrl `git.remoteUrl` from a scanned project, or undefined.
 * @returns Canonical `host/owner/repo`, or `null` when there is no usable
 *          remote (such projects group alone, i.e. do not form a group).
 */
export function normalizeRemote(
  remoteUrl: string | undefined | null
): string | null {
  if (!remoteUrl) return null;
  let rest = remoteUrl.trim();
  if (!rest) return null;

  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rest);
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // `user@` / `user:pass@` — `[^/@]*` keeps this anchored to the authority.
  rest = rest.replace(/^[^/@]*@/, "");
  // SCP-style `host:owner/repo`. The negative lookahead spares `host:8080`.
  // The scanner already rewrites this form, so it is belt-and-braces for
  // callers that hand us a raw remote.
  rest = rest.replace(/^([^/:]+):(?!\d)/, "$1/");
  rest = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const segments = rest.split("/").filter(Boolean);
  // Host plus at least owner and repo. Fewer cannot identify a repo.
  if (segments.length < 3) return null;

  const host = segments[0];
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  // Without a scheme, demand a dotted host so a bare path like "a/b/c" is
  // rejected rather than silently accepted as a remote.
  if (!hadScheme && !host.includes(".")) return null;

  // Keep every path segment, not just the last two: GitLab subgroups nest
  // (`gitlab.com/group/subgroup/repo`), and collapsing them would merge two
  // distinct repos that share a leaf name.
  //
  // Case is folded across the whole key. GitHub, GitLab and Bitbucket all
  // treat owner/repo case-insensitively, so `Owner/Repo` and `owner/repo`
  // are one repo — and a Windows clone from a pasted URL next to a WSL clone
  // from a typed one is exactly the divergence this feature exists to
  // reconcile. Folding can only mis-merge repos differing *solely* in case;
  // not folding fails the common case invisibly, with no signal at all.
  return segments.join("/").toLowerCase();
}
