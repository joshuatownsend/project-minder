import { describe, it, expect } from "vitest";
import { groupForProject } from "@/lib/groups/forProject";
import type { GroupableProject } from "@/lib/groups/derive";

function project(slug: string, path: string, remoteUrl?: string): GroupableProject {
  return {
    slug,
    path,
    git: remoteUrl ? { branch: "main", isDirty: false, uncommittedCount: 0, remoteUrl } : undefined,
  };
}

const REMOTE = "https://github.com/acme/foo.git";
const win = project("foo", "C:\\dev\\foo", REMOTE);
const wsl = project("foo-2", "\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\foo", REMOTE);
const other = project("bar", "C:\\dev\\bar", "https://github.com/acme/bar.git");
const noRemote = project("baz", "C:\\dev\\baz");

describe("groupForProject", () => {
  it("returns the group a member belongs to, with the member count", () => {
    const ref = groupForProject([win, wsl, other], "foo-2");
    expect(ref).toEqual({ slug: "foo", name: "foo", memberCount: 2 });
  });

  it("is undefined for a project that groups alone, or has no remote", () => {
    expect(groupForProject([win, wsl, other], "bar")).toBeUndefined();
    expect(groupForProject([win, wsl, noRemote], "baz")).toBeUndefined();
  });

  it("is undefined for an unknown slug", () => {
    expect(groupForProject([win, wsl], "nope")).toBeUndefined();
  });

  it("honours the opt-out list exactly as the dashboard derivation does", () => {
    // Opting one checkout out leaves a group of one, which is never emitted —
    // so neither member reports a group.
    const opts = { ungroupedPaths: ["C:/dev/foo"] };
    expect(groupForProject([win, wsl], "foo", opts)).toBeUndefined();
    expect(groupForProject([win, wsl], "foo-2", opts)).toBeUndefined();
  });
});
