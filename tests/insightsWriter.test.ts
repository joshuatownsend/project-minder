import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendInsights } from "@/lib/insightsWriter";
import { InsightEntry } from "@/lib/types";

// Mock fs
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);

beforeEach(() => vi.clearAllMocks());

function makeEntry(overrides: Partial<InsightEntry> = {}): InsightEntry {
  return {
    id: "abc123def456",
    content: "Test insight content",
    sessionId: "session1",
    date: "2026-04-10T12:00:00.000Z",
    project: "test-project",
    projectPath: "C:\\dev\\test-project",
    ...overrides,
  };
}

describe("appendInsights", () => {
  it("returns 0 for empty entries array", async () => {
    const result = await appendInsights("C:\\dev\\test", []);
    expect(result.count).toBe(0);
    expect(result.content).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("writes new insights to a new file", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT")); // No existing file
    mockWriteFile.mockResolvedValue();

    const result = await appendInsights("C:\\dev\\test", [makeEntry()]);
    expect(result.count).toBe(1);
    expect(mockWriteFile).toHaveBeenCalledOnce();

    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain("# Insights");
    expect(written).toContain("<!-- insight:abc123def456");
    expect(written).toContain("## ★ Insight");
    expect(written).toContain("Test insight content");
    expect(result.content).toBe(written);
  });

  it("deduplicates against existing entries", async () => {
    mockReadFile.mockResolvedValue(
      `# Insights\n\n<!-- insight:abc123def456 | session:s1 | 2026-04-10T12:00:00.000Z -->\n## ★ Insight\nExisting.\n\n---\n`
    );
    mockWriteFile.mockResolvedValue();

    const result = await appendInsights("C:\\dev\\test", [
      makeEntry({ id: "abc123def456" }),
    ]);
    expect(result.count).toBe(0);
    expect(result.content).toBeNull();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("deduplicates within the same batch", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockWriteFile.mockResolvedValue();

    const result = await appendInsights("C:\\dev\\test", [
      makeEntry({ id: "aaa111" }),
      makeEntry({ id: "aaa111" }), // duplicate
    ]);
    expect(result.count).toBe(1);
  });

  it("sorts new entries by date descending", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockWriteFile.mockResolvedValue();

    await appendInsights("C:\\dev\\test", [
      makeEntry({ id: "older", date: "2026-04-08T12:00:00.000Z", content: "Older" }),
      makeEntry({ id: "newer", date: "2026-04-10T12:00:00.000Z", content: "Newer" }),
    ]);

    const written = mockWriteFile.mock.calls[0][1] as string;
    const olderIdx = written.indexOf("insight:newer");
    const newerIdx = written.indexOf("insight:older");
    expect(olderIdx).toBeLessThan(newerIdx); // newer appears first
  });

  it("prepends new entries before existing ones", async () => {
    mockReadFile.mockResolvedValue(
      `# Insights\n\n<!-- insight:existing1 | session:s1 | 2026-04-08T12:00:00.000Z -->\n## ★ Insight\nOld insight.\n\n---\n`
    );
    mockWriteFile.mockResolvedValue();

    await appendInsights("C:\\dev\\test", [
      makeEntry({ id: "new1", content: "New insight" }),
    ]);

    const written = mockWriteFile.mock.calls[0][1] as string;
    const newIdx = written.indexOf("insight:new1");
    const oldIdx = written.indexOf("insight:existing1");
    expect(newIdx).toBeLessThan(oldIdx);
  });
});
