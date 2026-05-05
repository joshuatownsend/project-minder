import { describe, it, expect } from "vitest";
import { filterCommitsInInterval } from "@/lib/scanner/git";
import type { CommitMeta } from "@/lib/scanner/git";

function commit(date: string, subject = "msg"): CommitMeta {
  return { sha: "abc123", date, subject };
}

const T1 = "2026-01-01T00:00:00.000Z"; // 1735689600000
const T2 = "2026-01-02T00:00:00.000Z"; // 1735776000000
const T3 = "2026-01-03T00:00:00.000Z"; // 1735862400000
const T4 = "2026-01-04T00:00:00.000Z"; // 1735948800000

const startMs = new Date(T2).getTime();
const endMs = new Date(T3).getTime();

describe("filterCommitsInInterval", () => {
  it("returns empty array when given no commits", () => {
    expect(filterCommitsInInterval([], startMs, endMs)).toHaveLength(0);
  });

  it("includes commits exactly on the start boundary (inclusive)", () => {
    const result = filterCommitsInInterval([commit(T2)], startMs, endMs);
    expect(result).toHaveLength(1);
  });

  it("includes commits exactly on the end boundary (inclusive)", () => {
    const result = filterCommitsInInterval([commit(T3)], startMs, endMs);
    expect(result).toHaveLength(1);
  });

  it("excludes commits before the start boundary", () => {
    const result = filterCommitsInInterval([commit(T1)], startMs, endMs);
    expect(result).toHaveLength(0);
  });

  it("excludes commits after the end boundary", () => {
    const result = filterCommitsInInterval([commit(T4)], startMs, endMs);
    expect(result).toHaveLength(0);
  });

  it("filters mixed commits correctly", () => {
    const commits = [commit(T1), commit(T2), commit(T3), commit(T4)];
    const result = filterCommitsInInterval(commits, startMs, endMs);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.date)).toEqual([T2, T3]);
  });

  it("preserves commit fields on matching entries", () => {
    const c = { sha: "deadbeef", date: T2, subject: "feat: add thing" };
    const result = filterCommitsInInterval([c], startMs, endMs);
    expect(result[0]).toEqual(c);
  });

  it("returns empty when interval is zero-width and no commit matches exact ms", () => {
    const midMs = startMs + 1000;
    const result = filterCommitsInInterval([commit(T2)], midMs, midMs);
    expect(result).toHaveLength(0);
  });

  it("returns single commit when interval is zero-width and commit matches exactly", () => {
    const result = filterCommitsInInterval([commit(T2)], startMs, startMs);
    expect(result).toHaveLength(1);
  });
});
