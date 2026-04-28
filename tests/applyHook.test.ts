import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  applyHook,
  checkSourceProjectPath,
  extractHookScriptRefs,
} from "@/lib/template/applyHook";
import type { HookEntry } from "@/lib/types";

let tmp: string;
let sourceProj: string;
let targetProj: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "applyHook-test-"));
  sourceProj = path.join(tmp, "source");
  targetProj = path.join(tmp, "target");
  await fs.mkdir(path.join(sourceProj, ".claude"), { recursive: true });
  await fs.mkdir(path.join(targetProj, ".claude"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function entry(invocation: string, opts: Partial<HookEntry> = {}): HookEntry {
  return {
    event: "PostToolUse",
    matcher: "Edit",
    commands: [{ type: "command", command: invocation }],
    source: "project",
    sourcePath: path.join(sourceProj, ".claude", "settings.json"),
    ...opts,
  };
}

async function readSettings(p: string): Promise<unknown> {
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw);
}

describe("applyHook — happy path", () => {
  it("creates settings.json when target has none and writes the hook", async () => {
    const result = await applyHook({
      entry: entry("echo hi"),
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("applied");

    const doc = (await readSettings(
      path.join(targetProj, ".claude", "settings.json")
    )) as { hooks: Record<string, unknown> };
    const arr = (doc.hooks.PostToolUse as unknown[]);
    expect(arr).toHaveLength(1);
    expect(arr[0]).toMatchObject({ matcher: "Edit", hooks: [{ command: "echo hi" }] });
  });

  it("preserves unrelated keys in existing settings.json", async () => {
    const settingsPath = path.join(targetProj, ".claude", "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["x"] }, otherKey: 42 }, null, 2),
      "utf-8"
    );

    await applyHook({
      entry: entry("echo hi"),
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    const doc = (await readSettings(settingsPath)) as Record<string, unknown>;
    expect(doc.permissions).toEqual({ allow: ["x"] });
    expect(doc.otherKey).toBe(42);
    expect(doc.hooks).toBeDefined();
  });

  it("appends to an existing matcher group instead of duplicating it", async () => {
    const settingsPath = path.join(targetProj, ".claude", "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              { matcher: "Edit", hooks: [{ type: "command", command: "echo existing" }] },
            ],
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await applyHook({
      entry: entry("echo new"),
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    const doc = (await readSettings(settingsPath)) as { hooks: { PostToolUse: unknown[] } };
    const arr = doc.hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].matcher).toBe("Edit");
    expect(arr[0].hooks.map((h) => h.command)).toEqual(["echo existing", "echo new"]);
  });
});

describe("applyHook — idempotency + conflict handling", () => {
  it("re-applying the same invocation produces no duplicates (skip)", async () => {
    const e = entry("echo hi");
    await applyHook({ entry: e, sourceProjectPath: sourceProj, targetProjectPath: targetProj, conflict: "skip" });
    const second = await applyHook({
      entry: e,
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    expect(second.status).toBe("skipped");
    const doc = (await readSettings(
      path.join(targetProj, ".claude", "settings.json")
    )) as { hooks: { PostToolUse: Array<{ hooks: unknown[] }> } };
    expect(doc.hooks.PostToolUse[0].hooks).toHaveLength(1);
  });

  it("rename is rejected for hooks with NOT_SUPPORTED error", async () => {
    const e = entry("echo hi");
    await applyHook({ entry: e, sourceProjectPath: sourceProj, targetProjectPath: targetProj, conflict: "skip" });
    const second = await applyHook({
      entry: e,
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "rename",
    });
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("RENAME_NOT_SUPPORTED_FOR_HOOK");
  });
});

describe("applyHook — local→project promotion + warnings", () => {
  it("promotes a local source to settings.json with a warning", async () => {
    const localEntry = entry("echo hi", { source: "local" });
    const result = await applyHook({
      entry: localEntry,
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings?.[0]).toMatch(/local-scope/);

    // Confirm the entry landed in settings.json (project-shared) NOT settings.local.json.
    await expect(
      fs.access(path.join(targetProj, ".claude", "settings.local.json"))
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(targetProj, ".claude", "settings.json"))
    ).resolves.toBeUndefined();
  });
});

describe("applyHook — script reference handling", () => {
  it("copies referenced .claude/hooks/<name> scripts alongside", async () => {
    await fs.mkdir(path.join(sourceProj, ".claude", "hooks"), { recursive: true });
    await fs.writeFile(path.join(sourceProj, ".claude", "hooks", "format.sh"), "#!/bin/sh\necho format", "utf-8");

    const result = await applyHook({
      entry: entry("./.claude/hooks/format.sh"),
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    const copied = await fs.readFile(path.join(targetProj, ".claude", "hooks", "format.sh"), "utf-8");
    expect(copied).toBe("#!/bin/sh\necho format");
  });

  it("rejects invocations containing absolute paths into source project", async () => {
    const result = await applyHook({
      entry: entry(`bash ${sourceProj}/.claude/hooks/x.sh`),
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PROJECT_PATH_IN_SOURCE");
  });

  it("recognizes $CLAUDE_PROJECT_DIR-style script references", () => {
    const refs = extractHookScriptRefs("$CLAUDE_PROJECT_DIR/.claude/hooks/abc.sh");
    expect(refs).toEqual(["abc.sh"]);
  });

  it("recognizes ${CLAUDE_PROJECT_DIR} brace form", () => {
    const refs = extractHookScriptRefs("${CLAUDE_PROJECT_DIR}/.claude/hooks/abc.sh");
    expect(refs).toEqual(["abc.sh"]);
  });

  it("checkSourceProjectPath flags absolute source paths", () => {
    // Use a real-resolved path so this works cross-platform (Windows resolves "/src" → "C:\src").
    const realSource = sourceProj;
    const cmd = `bash ${realSource}/.claude/hooks/x.sh`;
    expect(checkSourceProjectPath(cmd, realSource)).toMatch(
      /absolute path into the source project/
    );
    expect(checkSourceProjectPath("bash $CLAUDE_PROJECT_DIR/.claude/hooks/x.sh", realSource)).toBeNull();
  });
});

describe("applyHook — malformed target", () => {
  it("refuses to overwrite a malformed settings.json", async () => {
    const settingsPath = path.join(targetProj, ".claude", "settings.json");
    await fs.writeFile(settingsPath, "{ this is not json", "utf-8");

    const result = await applyHook({
      entry: entry("echo hi"),
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MALFORMED_TARGET");

    // File unchanged.
    expect(await fs.readFile(settingsPath, "utf-8")).toBe("{ this is not json");
  });
});

describe("applyHook — dryRun", () => {
  it("dryRun returns would-apply with no filesystem changes", async () => {
    const result = await applyHook({
      entry: entry("echo hi"),
      sourceProjectPath: sourceProj,
      targetProjectPath: targetProj,
      conflict: "skip",
      dryRun: true,
    });

    expect(result.status).toBe("would-apply");
    expect(result.diffPreview).toContain("[append hook]");
    await expect(
      fs.access(path.join(targetProj, ".claude", "settings.json"))
    ).rejects.toThrow();
  });
});
