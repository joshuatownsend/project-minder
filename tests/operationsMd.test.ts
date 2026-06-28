import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseOperationsMd,
  scanOperationsMd,
  scanOperationsArchive,
} from "@/lib/scanner/operationsMd";

vi.mock("fs", () => ({
  promises: { readFile: vi.fn() },
}));
import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);

describe("parseOperationsMd — section classification", () => {
  it("maps each of the five canonical headings to its key", () => {
    const md = [
      "# Operations — my-app",
      "## Backups",
      "## Monitoring",
      "## On-call",
      "## Secrets",
      "## Restore",
    ].join("\n");
    const info = parseOperationsMd(md);
    expect(info?.sections.map((s) => s.key)).toEqual([
      "backups",
      "monitoring",
      "oncall",
      "secrets",
      "restore",
    ]);
  });

  it("recognizes synonyms (Disaster Recovery → restore, Alerting → monitoring)", () => {
    const md = [
      "## Disaster Recovery",
      "## Alerting",
      "## Escalation",
      "## Credential Rotation",
      "## Snapshot Retention",
    ].join("\n");
    const info = parseOperationsMd(md);
    expect(info?.sections.map((s) => s.key)).toEqual([
      "restore",
      "monitoring",
      "oncall",
      "secrets",
      "backups",
    ]);
  });

  it("keeps unrecognized headings as 'other' (not dropped)", () => {
    const info = parseOperationsMd("## Cost notes\nSome prose.");
    expect(info?.sections).toHaveLength(1);
    expect(info?.sections[0].key).toBe("other");
    expect(info?.sections[0].heading).toBe("Cost notes");
  });

  it("preserves the verbatim heading text", () => {
    const info = parseOperationsMd("## Monitoring & Alerting");
    expect(info?.sections[0].heading).toBe("Monitoring & Alerting");
    expect(info?.sections[0].key).toBe("monitoring");
  });
});

describe("parseOperationsMd — items, details, prose", () => {
  it("counts checkbox items into totalItems/pendingItems with done state", () => {
    const md = [
      "## Backups",
      "- [x] Nightly snapshot configured",
      "- [ ] Verify restore drill",
      "## Monitoring",
      "- [ ] Wire uptime alerts",
    ].join("\n");
    const info = parseOperationsMd(md);
    expect(info?.totalItems).toBe(3);
    expect(info?.pendingItems).toBe(2);

    const backups = info?.sections.find((s) => s.key === "backups");
    expect(backups?.items.map((it) => it.done)).toEqual([true, false]);
    expect(backups?.items[0].text).toBe("Nightly snapshot configured");
  });

  it("attaches indented detail lines to their item", () => {
    const md = [
      "## Backups",
      "- [ ] Nightly snapshot to S3",
      "  `aws s3 sync ...`",
      "  Retention: 30 days",
    ].join("\n");
    const info = parseOperationsMd(md);
    const item = info?.sections[0].items[0];
    expect(item?.details).toEqual(["`aws s3 sync ...`", "Retention: 30 days"]);
  });

  it("accumulates non-checkbox prose into the section body", () => {
    const md = [
      "## Restore",
      "Primary is Postgres on Neon.",
      "Restore from the latest PITR snapshot.",
    ].join("\n");
    const info = parseOperationsMd(md);
    expect(info?.sections[0].body).toBe(
      "Primary is Postgres on Neon.\nRestore from the latest PITR snapshot.",
    );
    expect(info?.sections[0].items).toHaveLength(0);
  });

  it("records the 1-based heading line number", () => {
    const md = ["# title", "", "## Backups", "- [ ] thing"].join("\n");
    const info = parseOperationsMd(md);
    expect(info?.sections[0].line).toBe(3);
    expect(info?.sections[0].items[0].lineNumber).toBe(4);
  });

  it("returns undefined for empty/whitespace content (no sections)", () => {
    expect(parseOperationsMd("")).toBeUndefined();
    expect(parseOperationsMd("   \n\n  ")).toBeUndefined();
    expect(parseOperationsMd("# Operations\nJust a title, no sections.")).toBeUndefined();
  });
});

describe("scanOperationsMd / scanOperationsArchive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads OPERATIONS.md and parses it", async () => {
    mockReadFile.mockResolvedValue("## Backups\n- [ ] Snapshot\n");
    const info = await scanOperationsMd("C:\\dev\\proj");
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringMatching(/OPERATIONS\.md$/),
      "utf-8",
    );
    expect(info?.totalItems).toBe(1);
  });

  it("returns undefined on ENOENT", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await scanOperationsMd("C:\\dev\\proj")).toBeUndefined();
  });

  it("scanOperationsArchive reads the .archive.md filename", async () => {
    mockReadFile.mockResolvedValue("## Restore\n- [x] Old drill\n");
    const info = await scanOperationsArchive("C:\\dev\\proj");
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringMatching(/OPERATIONS\.archive\.md$/),
      "utf-8",
    );
    expect(info?.sections[0].key).toBe("restore");
  });
});
