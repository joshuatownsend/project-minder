import { describe, it, expect } from "vitest";
import { queryKeys } from "@/lib/queryKeys";

describe("queryKeys", () => {
  it("namespaces session list vs detail", () => {
    expect(queryKeys.sessions.all()).toEqual(["sessions", "list"]);
    expect(queryKeys.sessions.detail("abc")).toEqual([
      "sessions",
      "detail",
      "abc",
    ]);
  });

  it("returns a stable stats key", () => {
    expect(queryKeys.stats()).toEqual(["stats"]);
  });

  it("normalizes optional params to null so omitted == undefined", () => {
    // useUsage("week") and useUsage("week", undefined) must hit one cache entry.
    expect(queryKeys.usage("week")).toEqual(queryKeys.usage("week", undefined));
    expect(queryKeys.usage("week")).toEqual(["usage", "week", null]);
    expect(queryKeys.usage("month", "proj")).toEqual([
      "usage",
      "month",
      "proj",
    ]);
  });

  it("keeps distinct usage keys for distinct params", () => {
    expect(queryKeys.usage("week", "a")).not.toEqual(
      queryKeys.usage("week", "b"),
    );
    expect(queryKeys.usage("week")).not.toEqual(queryKeys.usage("month"));
  });

  it("normalizes all three agent/skill filter params", () => {
    expect(queryKeys.agents()).toEqual(["agents", null, null, null]);
    expect(queryKeys.agents("user", undefined, "foo")).toEqual([
      "agents",
      "user",
      null,
      "foo",
    ]);
    expect(queryKeys.skills()).toEqual(["skills", null, null, null]);
  });

  it("prevents insights list/detail key collisions", () => {
    // A project-filtered list and a detail lookup that share a slug-like segment
    // must never resolve to the same key.
    const listForSlug = queryKeys.insights.all("my-proj");
    const detailForSlug = queryKeys.insights.detail("my-proj");
    expect(listForSlug).not.toEqual(detailForSlug);
    expect(listForSlug).toEqual(["insights", "list", "my-proj", null]);
    expect(detailForSlug).toEqual(["insights", "detail", "my-proj"]);
  });

  it("treats an empty all-insights filter as null", () => {
    expect(queryKeys.insights.all()).toEqual(["insights", "list", null, null]);
  });
});
