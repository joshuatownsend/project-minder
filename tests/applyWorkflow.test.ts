import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { applyWorkflow } from "@/lib/template/applyWorkflow";

let tmp: string;
let source: string;
let target: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "applyWorkflow-test-"));
  source = path.join(tmp, "source");
  target = path.join(tmp, "target");
  await fs.mkdir(path.join(source, ".github", "workflows"), { recursive: true });
  await fs.mkdir(target, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeSourceWorkflow(name: string, content: string) {
  await fs.writeFile(path.join(source, ".github", "workflows", name), content, "utf-8");
}

describe("applyWorkflow — happy path", () => {
  it("copies a workflow file into the target", async () => {
    await writeSourceWorkflow("ci.yml", "name: ci\non: push\n");
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "ci.yml",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(path.join(target, ".github", "workflows", "ci.yml"), "utf-8");
    expect(written).toBe("name: ci\non: push\n");
  });

  it("creates parent dirs when target/.github/workflows doesn't exist", async () => {
    await writeSourceWorkflow("ci.yml", "name: ci\n");
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "ci.yml",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(true);
    const stat = await fs.stat(path.join(target, ".github", "workflows"));
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("applyWorkflow — conflicts", () => {
  beforeEach(async () => {
    await writeSourceWorkflow("ci.yml", "new\n");
    await fs.mkdir(path.join(target, ".github", "workflows"), { recursive: true });
    await fs.writeFile(path.join(target, ".github", "workflows", "ci.yml"), "existing\n", "utf-8");
  });

  it("skips when target exists and conflict=skip", async () => {
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "ci.yml",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.status).toBe("skipped");
    expect(await fs.readFile(path.join(target, ".github", "workflows", "ci.yml"), "utf-8")).toBe(
      "existing\n"
    );
  });

  it("overwrites when conflict=overwrite", async () => {
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "ci.yml",
      targetProjectPath: target,
      conflict: "overwrite",
    });
    expect(result.status).toBe("applied");
    expect(await fs.readFile(path.join(target, ".github", "workflows", "ci.yml"), "utf-8")).toBe(
      "new\n"
    );
  });

  it("renames to .copy.yml when conflict=rename", async () => {
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "ci.yml",
      targetProjectPath: target,
      conflict: "rename",
    });
    expect(result.status).toBe("applied");
    expect(result.changedFiles[0]).toMatch(/ci\.copy\.yml$/);
  });

  it("rejects merge for workflow units", async () => {
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "ci.yml",
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MERGE_NOT_SUPPORTED_FOR_WORKFLOW");
  });
});

describe("applyWorkflow — refusals", () => {
  it("rejects path traversal in workflowKey", async () => {
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "../../escape.yml",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_WORKFLOW_KEY");
  });

  it("rejects absolute workflowKey", async () => {
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: path.resolve(tmp, "elsewhere.yml"),
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_WORKFLOW_KEY");
  });

  it("returns UNIT_NOT_FOUND when source workflow doesn't exist", async () => {
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "missing.yml",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNIT_NOT_FOUND");
  });
});

describe("applyWorkflow — dryRun", () => {
  it("dryRun returns would-apply without writing", async () => {
    await writeSourceWorkflow("ci.yml", "name: ci\n");
    const result = await applyWorkflow({
      sourceProjectPath: source,
      workflowKey: "ci.yml",
      targetProjectPath: target,
      conflict: "skip",
      dryRun: true,
    });
    expect(result.status).toBe("would-apply");
    await expect(fs.access(path.join(target, ".github", "workflows", "ci.yml"))).rejects.toThrow();
  });
});
