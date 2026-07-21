import { describe, it, expect } from "vitest";
import { normalizeRemote } from "@/lib/groups/identity";
import {
  deriveProjectGroups,
  type GroupableProject,
} from "@/lib/groups/derive";

/** Minimal fixture factory — mirrors the `opsSummary.test.ts` pattern. */
function project(
  slug: string,
  path: string,
  remoteUrl?: string,
  usageHomeKey?: string
): GroupableProject {
  return {
    slug,
    path,
    git: remoteUrl ? { branch: "main", isDirty: false, uncommittedCount: 0, remoteUrl } : undefined,
    usageHomeKey,
  };
}

describe("normalizeRemote", () => {
  it("reduces an https remote to host/owner/repo", () => {
    expect(normalizeRemote("https://github.com/joshuatownsend/bamcli")).toBe(
      "github.com/joshuatownsend/bamcli"
    );
  });

  it("strips a trailing .git and a trailing slash", () => {
    expect(normalizeRemote("https://github.com/o/r.git")).toBe("github.com/o/r");
    expect(normalizeRemote("https://github.com/o/r/")).toBe("github.com/o/r");
    expect(normalizeRemote("https://github.com/o/r.git/")).toBe("github.com/o/r");
  });

  it("drops a user@ prefix", () => {
    expect(normalizeRemote("ssh://git@github.com/o/r")).toBe("github.com/o/r");
  });

  it("folds case so a differently-cased clone still groups", () => {
    // Asserted against a literal, not against another call — comparing two
    // calls would pass trivially while both returned null.
    expect(normalizeRemote("https://GitHub.com/Owner/Repo")).toBe(
      "github.com/owner/repo"
    );
  });

  it("keeps different hosts apart even when owner/repo match", () => {
    expect(normalizeRemote("https://github.com/o/r")).toBe("github.com/o/r");
    expect(normalizeRemote("https://gitlab.com/o/r")).toBe("gitlab.com/o/r");
  });

  it("is not github-specific", () => {
    expect(normalizeRemote("https://gitlab.com/o/r")).toBe("gitlab.com/o/r");
  });

  it("returns null for missing or unusable remotes", () => {
    expect(normalizeRemote(undefined)).toBeNull();
    expect(normalizeRemote(null)).toBeNull();
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("not a url")).toBeNull();
    // Too few segments to identify a repo.
    expect(normalizeRemote("https://github.com/owner")).toBeNull();
  });
});

describe("deriveProjectGroups", () => {
  const WIN = "C:\\dev\\bamcli";
  const WSL = "\\\\wsl.localhost\\Ubuntu\\home\\josh\\bamcli";
  const REMOTE = "https://github.com/joshuatownsend/bamcli";

  it("groups two checkouts sharing a remote", () => {
    const groups = deriveProjectGroups([
      project("bamcli", WIN, REMOTE),
      project("bamcli-library", WSL, REMOTE, "wsl:Ubuntu"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("github.com/joshuatownsend/bamcli");
    expect(groups[0].slug).toBe("bamcli");
    expect(groups[0].members.map((m) => m.slug)).toEqual([
      "bamcli",
      "bamcli-library",
    ]);
  });

  it("never emits a group of one", () => {
    const groups = deriveProjectGroups([
      project("solo", "C:\\dev\\solo", "https://github.com/o/solo"),
      project("other", "C:\\dev\\other", "https://github.com/o/other"),
    ]);
    expect(groups).toEqual([]);
  });

  it("does not group projects that have no remote", () => {
    const groups = deriveProjectGroups([
      project("a", "C:\\dev\\a"),
      project("b", "C:\\dev\\b"),
    ]);
    expect(groups).toEqual([]);
  });

  it("groups across differing remote spellings of the same repo", () => {
    const groups = deriveProjectGroups([
      project("a", "C:\\dev\\a", "https://github.com/o/r"),
      project("b", "C:\\dev\\b", "https://github.com/o/r.git"),
      project("c", "C:\\dev\\c", "ssh://git@github.com/o/r"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it("carries usageHomeKey through, and omits it when absent", () => {
    const groups = deriveProjectGroups([
      project("bamcli", WIN, REMOTE),
      project("bamcli-library", WSL, REMOTE, "wsl:Ubuntu"),
    ]);
    const [win, wsl] = groups[0].members;
    expect(win.usageHomeKey).toBeUndefined();
    expect(wsl.usageHomeKey).toBe("wsl:Ubuntu");
  });

  describe("ungroupedPaths opt-out", () => {
    it("splits an opted-out checkout back out of its group", () => {
      const groups = deriveProjectGroups(
        [
          project("bamcli", WIN, REMOTE),
          project("bamcli-library", WSL, REMOTE),
        ],
        { ungroupedPaths: [WSL] }
      );
      // One member left is not a group.
      expect(groups).toEqual([]);
    });

    it("keeps the remaining members grouped when one of three opts out", () => {
      const groups = deriveProjectGroups(
        [
          project("a", "C:\\dev\\a", REMOTE),
          project("b", "C:\\dev\\b", REMOTE),
          project("c", "C:\\dev\\c", REMOTE),
        ],
        { ungroupedPaths: ["C:\\dev\\c"] }
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].members.map((m) => m.slug)).toEqual(["a", "b"]);
    });

    it("matches forward-slash paths, which is what hand-edited JSON invites", () => {
      // `.minder.json` needs doubled backslashes for a Windows path, so
      // "C:/dev/bamcli" is the natural thing to type. If separators were not
      // folded, the opt-out would silently match nothing.
      const groups = deriveProjectGroups(
        [
          project("bamcli", "C:\\dev\\bamcli", REMOTE),
          project("bamcli-b", "C:\\dev\\bamclib", REMOTE),
        ],
        { ungroupedPaths: ["C:/dev/bamclib"] }
      );
      expect(groups).toEqual([]);
    });

    it("ignores a trailing separator on a configured path", () => {
      const groups = deriveProjectGroups(
        [
          project("bamcli", "C:\\dev\\bamcli", REMOTE),
          project("bamcli-b", "C:\\dev\\bamclib", REMOTE),
        ],
        { ungroupedPaths: ["C:\\dev\\bamclib\\"] }
      );
      expect(groups).toEqual([]);
    });

    it("matches paths case-insensitively, as Windows does", () => {
      const groups = deriveProjectGroups(
        [
          project("bamcli", WIN, REMOTE),
          project("bamcli-library", WSL, REMOTE),
        ],
        { ungroupedPaths: [WSL.toUpperCase()] }
      );
      expect(groups).toEqual([]);
    });
  });

  describe("group slug assignment", () => {
    it("disambiguates same-named repos from different owners", () => {
      const groups = deriveProjectGroups([
        project("a1", "C:\\dev\\a1", "https://github.com/alice/tool"),
        project("a2", "D:\\dev\\a2", "https://github.com/alice/tool"),
        project("b1", "C:\\dev\\b1", "https://github.com/bob/tool"),
        project("b2", "D:\\dev\\b2", "https://github.com/bob/tool"),
      ]);
      expect(groups).toHaveLength(2);
      const slugs = groups.map((g) => g.slug).sort();
      // First by key order keeps the bare name; the other takes the owner suffix.
      expect(slugs).toEqual(["tool", "tool-bob"]);
      expect(new Set(slugs).size).toBe(2);
    });

    it("sanitizes characters that are not slug-safe", () => {
      const groups = deriveProjectGroups([
        project("a", "C:\\dev\\a", "https://github.com/o/My.Repo_Name"),
        project("b", "C:\\dev\\b", "https://github.com/o/My.Repo_Name"),
      ]);
      expect(groups[0].slug).toBe("my-repo-name");
    });
  });

  describe("determinism", () => {
    it("orders members by path and groups by key, regardless of input order", () => {
      const a = project("a", "C:\\dev\\a", "https://github.com/o/zzz");
      const b = project("b", "D:\\dev\\b", "https://github.com/o/zzz");
      const c = project("c", "C:\\dev\\c", "https://github.com/o/aaa");
      const d = project("d", "D:\\dev\\d", "https://github.com/o/aaa");

      const forward = deriveProjectGroups([a, b, c, d]);
      const reversed = deriveProjectGroups([d, c, b, a]);

      expect(forward).toEqual(reversed);
      expect(forward.map((g) => g.key)).toEqual([
        "github.com/o/aaa",
        "github.com/o/zzz",
      ]);
      expect(forward[0].members.map((m) => m.path)).toEqual([
        "C:\\dev\\c",
        "D:\\dev\\d",
      ]);
    });
  });

  describe("worktrees", () => {
    // Worktree directories never reach this function: their `.git` is a FILE
    // (`gitdir: …`), and `isGitRepo` (scanner/index.ts:151) requires a
    // DIRECTORY, so they are filtered out before slug assignment and attached
    // separately as WorktreeOverlay. This test pins the consequence — if a
    // future scanner change ever let them through, they would share the parent
    // remote and silently appear as phantom locations, which is Risk #4 in the
    // plan doc.
    it("would treat a leaked worktree dir as a phantom location", () => {
      const groups = deriveProjectGroups([
        project("bamcli", WIN, REMOTE),
        project(
          "bamcli--claude-worktrees-feat",
          "C:\\dev\\bamcli--claude-worktrees-feat",
          REMOTE
        ),
      ]);
      // Documents the hazard: grouping alone does NOT defend against it.
      // The defence is upstream, in isGitRepo.
      expect(groups).toHaveLength(1);
      expect(groups[0].members).toHaveLength(2);
    });
  });
});
