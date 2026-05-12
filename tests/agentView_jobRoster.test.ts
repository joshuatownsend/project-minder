import { describe, it, expect } from "vitest";
import { slugFromPath } from "@/lib/agentView/jobRoster";

describe("jobRoster — slugFromPath", () => {
  it("returns __unknown__ for undefined", () => {
    expect(slugFromPath(undefined)).toBe("__unknown__");
  });

  it("derives slug from Unix path", () => {
    expect(slugFromPath("/home/user/dev/my-app")).toBe("my-app");
  });

  it("derives slug from Windows path", () => {
    expect(slugFromPath("C:\\dev\\project-minder")).toBe("project-minder");
  });

  it("handles trailing slash on Unix path", () => {
    expect(slugFromPath("/home/user/dev/my-project/")).toBe("my-project");
  });

  it("handles trailing backslash on Windows path", () => {
    expect(slugFromPath("C:\\dev\\my-project\\")).toBe("my-project");
  });

  it("lowercases and strips special chars", () => {
    expect(slugFromPath("C:\\dev\\My App 2026")).toBe("my-app-2026");
  });
});
