import { describe, it, expect } from "vitest";
import { withGroups } from "@/lib/groups/withGroups";
import type { ProjectData, ScanResult } from "@/lib/types/project";

function project(slug: string, path: string, remoteUrl?: string): ProjectData {
  return {
    slug,
    name: slug,
    path,
    status: "active",
    usageSlug: `dev-${slug}`,
    usageDirName: `C--dev-${slug}`,
    dependencies: [],
    dockerPorts: [],
    externalServices: [],
    git: remoteUrl ? { branch: "main", isDirty: false, uncommittedCount: 0, remoteUrl } : undefined,
    claudeMdAudit: { status: "absent" } as unknown as ProjectData["claudeMdAudit"],
    scannedAt: "2026-09-03T00:00:00.000Z",
  } as ProjectData;
}

function scan(projects: ProjectData[]): ScanResult {
  return { projects, portConflicts: [], hiddenCount: 0, scannedAt: "2026-09-03T00:00:00.000Z" } as unknown as ScanResult;
}

describe("withGroups", () => {
  it("attaches derived groups when two checkouts share a remote", () => {
    const result = scan([
      project("foo", "C:\\dev\\foo", "https://github.com/me/foo"),
      project("foo-2", "D:\\dev\\foo", "https://github.com/me/foo"),
    ]);
    const out = withGroups(result, {});
    expect(out.groups).toHaveLength(1);
    expect(out.groups?.[0].members.map((m) => m.slug)).toEqual(["foo", "foo-2"]);
    // A new object, not a mutation of the cached result.
    expect(out).not.toBe(result);
    expect(result.groups).toBeUndefined();
  });

  it("omits the key entirely when nothing groups", () => {
    const result = scan([project("foo", "C:\\dev\\foo", "https://github.com/me/foo")]);
    const out = withGroups(result, {});
    expect(out).toBe(result);
    expect("groups" in out).toBe(false);
  });

  it("honours the opt-out list", () => {
    const result = scan([
      project("foo", "C:\\dev\\foo", "https://github.com/me/foo"),
      project("foo-2", "D:\\dev\\foo", "https://github.com/me/foo"),
    ]);
    expect(withGroups(result, { ungroupedPaths: ["D:/dev/foo"] }).groups).toBeUndefined();
  });
});
