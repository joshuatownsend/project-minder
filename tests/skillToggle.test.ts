import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";

vi.mock("fs", () => ({
  promises: {
    access: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("@/lib/configHistory", () => ({
  recordPreWrite: vi.fn().mockResolvedValue(null),
}));

import { promises as fs } from "fs";
import { toggleUserSkill, skillSubjectPath, ToggleError } from "@/lib/skillToggle";

const ACTIVE = path.resolve(os.homedir(), ".claude", "skills");
const DISABLED = path.resolve(os.homedir(), ".claude", "skills-disabled");

const mockAccess = vi.mocked(fs.access);
const mockRename = vi.mocked(fs.rename);
const mockMkdir = vi.mocked(fs.mkdir);
const mockStat = vi.mocked(fs.stat);

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  // By default, access succeeds (subject exists) and target doesn't exist (access throws ENOENT)
  mockStat.mockResolvedValue({ isDirectory: () => true } as ReturnType<typeof fs.stat> extends Promise<infer R> ? R : never);
});

describe("skillSubjectPath", () => {
  it("bundled → parent dir of SKILL.md", () => {
    const result = skillSubjectPath("/home/user/.claude/skills/my-skill/SKILL.md", "bundled");
    expect(result).toBe("/home/user/.claude/skills/my-skill");
  });

  it("standalone → the .md file itself", () => {
    const result = skillSubjectPath("/home/user/.claude/skills/quick.md", "standalone");
    expect(result).toBe("/home/user/.claude/skills/quick.md");
  });
});

describe("toggleUserSkill", () => {
  const activeSubject = path.join(ACTIVE, "my-skill");
  const disabledSubject = path.join(DISABLED, "my-skill");
  const expectedActive = path.join(ACTIVE, "my-skill");
  const expectedDisabled = path.join(DISABLED, "my-skill");

  describe("disable (enabled=false)", () => {
    it("renames from active to disabled root", async () => {
      // access: subject exists (success), target doesn't (ENOENT)
      mockAccess
        .mockResolvedValueOnce(undefined)    // subject exists
        .mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOENT" })); // target doesn't

      const result = await toggleUserSkill(activeSubject, false);
      expect(result.newPath).toBe(expectedDisabled);
      expect(mockRename).toHaveBeenCalledWith(activeSubject, expectedDisabled);
      expect(mockMkdir).toHaveBeenCalledWith(DISABLED, { recursive: true });
    });

    it("throws INVALID_SOURCE when subject is not in active root", async () => {
      const wrongSubject = "/tmp/random/skill";
      await expect(toggleUserSkill(wrongSubject, false)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    });

    it("throws DEST_EXISTS when target already exists", async () => {
      mockAccess
        .mockResolvedValueOnce(undefined)   // subject exists
        .mockResolvedValueOnce(undefined);  // target also exists (DEST_EXISTS condition)

      await expect(toggleUserSkill(activeSubject, false)).rejects.toMatchObject({ code: "DEST_EXISTS" });
    });
  });

  describe("enable (enabled=true)", () => {
    it("renames from disabled to active root", async () => {
      mockAccess
        .mockResolvedValueOnce(undefined)    // subject exists
        .mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOENT" })); // target doesn't

      const result = await toggleUserSkill(disabledSubject, true);
      expect(result.newPath).toBe(expectedActive);
      expect(mockRename).toHaveBeenCalledWith(disabledSubject, expectedActive);
    });

    it("throws INVALID_SOURCE when subject is not in disabled root", async () => {
      await expect(toggleUserSkill(activeSubject, true)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    });
  });

  it("throws NOT_FOUND when subject doesn't exist", async () => {
    mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(toggleUserSkill(activeSubject, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
