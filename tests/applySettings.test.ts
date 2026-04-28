import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { applySettings, mergeValues } from "@/lib/template/applySettings";

let tmp: string;
let source: string;
let target: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "applySettings-test-"));
  source = path.join(tmp, "source");
  target = path.join(tmp, "target");
  await fs.mkdir(path.join(source, ".claude"), { recursive: true });
  await fs.mkdir(path.join(target, ".claude"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeSource(doc: unknown) {
  await fs.writeFile(
    path.join(source, ".claude", "settings.json"),
    JSON.stringify(doc, null, 2),
    "utf-8"
  );
}

async function writeTarget(doc: unknown) {
  await fs.writeFile(
    path.join(target, ".claude", "settings.json"),
    JSON.stringify(doc, null, 2),
    "utf-8"
  );
}

async function readTarget(): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(path.join(target, ".claude", "settings.json"), "utf-8")
  );
}

describe("applySettings — happy path", () => {
  it("creates settings.json on target when absent and writes the value", async () => {
    await writeSource({ statusLine: "minimal" });
    const result = await applySettings({
      settingsPath: "statusLine",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("applied");
    const doc = (await readTarget()) as { statusLine: string };
    expect(doc.statusLine).toBe("minimal");
  });

  it("preserves unrelated keys in target settings.json", async () => {
    await writeSource({ permissions: { allow: ["Bash(npm:*)"] } });
    await writeTarget({ statusLine: "untouched", env: { OTHER: "x" } });
    await applySettings({
      settingsPath: "permissions.allow",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    const doc = (await readTarget()) as Record<string, unknown>;
    expect(doc.statusLine).toBe("untouched");
    expect(doc.env).toEqual({ OTHER: "x" });
    expect((doc.permissions as { allow: string[] }).allow).toEqual(["Bash(npm:*)"]);
  });
});

describe("applySettings — concat-dedupe for permissions.allow", () => {
  it("merges arrays at permissions.allow without duplicates", async () => {
    await writeSource({ permissions: { allow: ["Bash(git:*)", "Read(*)"] } });
    await writeTarget({ permissions: { allow: ["Bash(git:*)", "Edit(*)"] } });
    const result = await applySettings({
      settingsPath: "permissions.allow",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.status).toBe("merged");
    const doc = (await readTarget()) as { permissions: { allow: string[] } };
    expect(doc.permissions.allow.sort()).toEqual(["Bash(git:*)", "Edit(*)", "Read(*)"]);
  });

  it("overwrite policy replaces the entire allow list", async () => {
    await writeSource({ permissions: { allow: ["Bash(git:*)"] } });
    await writeTarget({ permissions: { allow: ["Edit(*)"] } });
    await applySettings({
      settingsPath: "permissions.allow",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "overwrite",
    });
    const doc = (await readTarget()) as { permissions: { allow: string[] } };
    expect(doc.permissions.allow).toEqual(["Bash(git:*)"]);
  });

  it("merge of whole `permissions` still triggers concat-dedupe at allow", async () => {
    await writeSource({
      permissions: { allow: ["Bash(git:*)"], deny: ["Bash(rm:*)"] },
    });
    await writeTarget({ permissions: { allow: ["Edit(*)"], ask: ["Read(*)"] } });
    await applySettings({
      settingsPath: "permissions",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    const doc = (await readTarget()) as {
      permissions: { allow: string[]; ask: string[]; deny: string[] };
    };
    expect(doc.permissions.allow.sort()).toEqual(["Bash(git:*)", "Edit(*)"]);
    expect(doc.permissions.ask).toEqual(["Read(*)"]);
    expect(doc.permissions.deny).toEqual(["Bash(rm:*)"]);
  });
});

describe("applySettings — non-concat array paths replace by default", () => {
  it("replaces a non-allowlisted array on merge", async () => {
    await writeSource({ customArray: [4, 5] });
    await writeTarget({ customArray: [1, 2, 3] });
    await applySettings({
      settingsPath: "customArray",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    const doc = (await readTarget()) as { customArray: number[] };
    expect(doc.customArray).toEqual([4, 5]);
  });
});

describe("applySettings — conflict policies", () => {
  it("skips when target has the key and policy=skip", async () => {
    await writeSource({ statusLine: "new" });
    await writeTarget({ statusLine: "existing" });
    const result = await applySettings({
      settingsPath: "statusLine",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.status).toBe("skipped");
    expect((await readTarget()) as { statusLine: string }).toEqual({ statusLine: "existing" });
  });

  it("rejects rename for settings keys", async () => {
    await writeSource({ statusLine: "x" });
    const result = await applySettings({
      settingsPath: "statusLine",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "rename",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RENAME_NOT_SUPPORTED_FOR_SETTINGS");
  });

  it("returns skipped for an idempotent merge (target already deep-equal)", async () => {
    const same = { permissions: { allow: ["Bash(git:*)"] } };
    await writeSource(same);
    await writeTarget(same);
    const result = await applySettings({
      settingsPath: "permissions.allow",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.status).toBe("skipped");
    expect(result.changedFiles).toEqual([]);
  });
});

describe("applySettings — refusals", () => {
  it("UNIT_NOT_FOUND when source path is absent", async () => {
    await writeSource({ statusLine: "x" });
    const result = await applySettings({
      settingsPath: "missing.key",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNIT_NOT_FOUND");
  });

  it("EMPTY_SETTINGS_PATH for empty key", async () => {
    await writeSource({ statusLine: "x" });
    const result = await applySettings({
      settingsPath: "",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EMPTY_SETTINGS_PATH");
  });

  it("MALFORMED_TARGET refuses to overwrite invalid target JSON", async () => {
    await writeSource({ statusLine: "x" });
    await fs.writeFile(
      path.join(target, ".claude", "settings.json"),
      "{ not valid",
      "utf-8"
    );
    const result = await applySettings({
      settingsPath: "statusLine",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MALFORMED_TARGET");
  });

  it("MALFORMED_SOURCE refuses to read invalid source JSON", async () => {
    await fs.writeFile(
      path.join(source, ".claude", "settings.json"),
      "{ broken",
      "utf-8"
    );
    const result = await applySettings({
      settingsPath: "statusLine",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MALFORMED_SOURCE");
  });

  it("PATH_NON_OBJECT_INTERMEDIATE when target intermediate is a scalar", async () => {
    await writeSource({ permissions: { allow: ["Bash(*)"] } });
    await writeTarget({ permissions: "scalar-instead-of-object" });
    const result = await applySettings({
      settingsPath: "permissions.allow",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PATH_NON_OBJECT_INTERMEDIATE");
  });
});

describe("applySettings — dryRun", () => {
  it("dryRun returns would-apply without writing", async () => {
    await writeSource({ statusLine: "preview" });
    const result = await applySettings({
      settingsPath: "statusLine",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
      dryRun: true,
    });
    expect(result.status).toBe("would-apply");
    expect(result.diffPreview).toContain("[add]");
    await expect(
      fs.access(path.join(target, ".claude", "settings.json"))
    ).rejects.toThrow();
  });

  it("dryRun shows merge preview for an existing target value", async () => {
    await writeSource({ permissions: { allow: ["Bash(git:*)"] } });
    await writeTarget({ permissions: { allow: ["Edit(*)"] } });
    const result = await applySettings({
      settingsPath: "permissions.allow",
      sourceProjectPath: source,
      targetProjectPath: target,
      conflict: "merge",
      dryRun: true,
    });
    expect(result.status).toBe("would-apply");
    expect(result.diffPreview).toContain("[merge]");
    // Target unchanged.
    const doc = (await readTarget()) as { permissions: { allow: string[] } };
    expect(doc.permissions.allow).toEqual(["Edit(*)"]);
  });
});

describe("mergeValues — direct unit tests", () => {
  it("source wins on type mismatch", () => {
    expect(mergeValues({ a: 1 }, "scalar", "")).toBe("scalar");
    expect(mergeValues([1, 2], { a: 1 }, "")).toEqual({ a: 1 });
  });
  it("scalar source replaces scalar target", () => {
    expect(mergeValues(1, 2, "anything")).toBe(2);
    expect(mergeValues("old", "new", "x")).toBe("new");
  });
  it("undefined target falls back to source", () => {
    expect(mergeValues(undefined, [1, 2], "x")).toEqual([1, 2]);
  });
  it("undefined source preserves target", () => {
    expect(mergeValues([1, 2], undefined, "x")).toEqual([1, 2]);
  });
});
