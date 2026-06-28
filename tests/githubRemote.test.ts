import { describe, it, expect } from "vitest";
import { parseGitHubRemote } from "@/lib/githubRemote";

describe("parseGitHubRemote", () => {
  describe("HTTPS remotes", () => {
    it("parses https without .git", () => {
      expect(parseGitHubRemote("https://github.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses https with .git suffix", () => {
      expect(parseGitHubRemote("https://github.com/owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses https with a trailing slash", () => {
      expect(parseGitHubRemote("https://github.com/owner/repo/")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses http (not just https)", () => {
      expect(parseGitHubRemote("http://github.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });
  });

  describe("SSH remotes", () => {
    it("parses SCP-style git@github.com:owner/repo.git", () => {
      expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses SCP-style without .git", () => {
      expect(parseGitHubRemote("git@github.com:owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses ssh:// URL form", () => {
      expect(parseGitHubRemote("ssh://git@github.com/owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });
  });

  describe("repo names with allowed special characters", () => {
    it("keeps a dot in the repo name (does not strip it as .git)", () => {
      expect(parseGitHubRemote("https://github.com/owner/my.repo")).toEqual({
        owner: "owner",
        repo: "my.repo",
      });
    });

    it("keeps dots/dashes/underscores", () => {
      expect(
        parseGitHubRemote("git@github.com:my-org/my_cool.project.git")
      ).toEqual({ owner: "my-org", repo: "my_cool.project" });
    });
  });

  describe("non-GitHub hosts → null", () => {
    it("rejects GitLab", () => {
      expect(parseGitHubRemote("git@gitlab.com:owner/repo.git")).toBeNull();
      expect(parseGitHubRemote("https://gitlab.com/owner/repo")).toBeNull();
    });

    it("rejects Bitbucket", () => {
      expect(parseGitHubRemote("https://bitbucket.org/owner/repo")).toBeNull();
    });

    it("rejects a github.com look-alike host", () => {
      expect(parseGitHubRemote("https://github.com.evil.com/owner/repo")).toBeNull();
      expect(parseGitHubRemote("https://notgithub.com/owner/repo")).toBeNull();
    });
  });

  describe("empty / garbage → null", () => {
    it("rejects empty string", () => {
      expect(parseGitHubRemote("")).toBeNull();
      expect(parseGitHubRemote("   ")).toBeNull();
    });

    it("rejects undefined and null", () => {
      expect(parseGitHubRemote(undefined)).toBeNull();
      expect(parseGitHubRemote(null)).toBeNull();
    });

    it("rejects a bare path / nonsense", () => {
      expect(parseGitHubRemote("owner/repo")).toBeNull();
      expect(parseGitHubRemote("just-some-text")).toBeNull();
      expect(parseGitHubRemote("https://github.com/owner")).toBeNull();
    });
  });

  describe("injection attempts → null (security regression for P2)", () => {
    it("rejects a remote with a shell metacharacter in the segment", () => {
      expect(parseGitHubRemote("https://github.com/owner/r;rm -rf /")).toBeNull();
      expect(parseGitHubRemote("https://github.com/owner/r$(whoami)")).toBeNull();
      expect(parseGitHubRemote("https://github.com/owner/r repo")).toBeNull();
    });

    it("rejects a remote whose owner contains a slash or colon", () => {
      expect(parseGitHubRemote("https://github.com/ow/ner/repo")).toBeNull();
      expect(parseGitHubRemote("git@github.com:ow:ner/repo.git")).toBeNull();
    });

    it("rejects extra path segments", () => {
      expect(
        parseGitHubRemote("https://github.com/owner/repo/extra")
      ).toBeNull();
    });
  });
});
