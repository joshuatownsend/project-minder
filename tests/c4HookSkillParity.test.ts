import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import yaml from "js-yaml";

import {
  coerceFrontmatterBoolean,
  parseFrontmatter,
} from "@/lib/indexer/parseFrontmatter";
import { resolvePluginSkillsRoots } from "@/lib/indexer/walkPlugins";
import { walkPluginSkills, walkUserSkills } from "@/lib/indexer/walkSkills";
import { parseHookPayload } from "@/lib/hooks/payload";
import { HOOK_EVENT_NAMES } from "@/lib/types";
import type { ProvenanceContext } from "@/lib/indexer/types";

// ── Frontmatter booleans (the live bug) ──────────────────────────────────────

describe("C4 — frontmatter boolean spellings", () => {
  it("accepts every spelling Claude Code accepts, case-insensitively", () => {
    for (const truthy of ["true", "TRUE", "yes", "Yes", "on", "ON", "1", " on "]) {
      expect(coerceFrontmatterBoolean(truthy)).toBe(true);
    }
    for (const falsy of ["false", "FALSE", "no", "No", "off", "OFF", "0", " off "]) {
      expect(coerceFrontmatterBoolean(falsy)).toBe(false);
    }
    expect(coerceFrontmatterBoolean(true)).toBe(true);
    expect(coerceFrontmatterBoolean(false)).toBe(false);
  });

  it("reads 1/0 as numbers, which is how YAML 1.2 delivers them", () => {
    // The reason string-only handling is not enough: js-yaml runs the YAML 1.2
    // core schema, so `key: 1` arrives as a number while `key: on` arrives as a
    // string. Both have to work or the coercion is half-done.
    const fm = parseFrontmatter("---\na: 1\nb: 0\nc: on\nd: yes\n---\nbody").fm;
    expect(typeof fm.a).toBe("number");
    expect(typeof fm.c).toBe("string");
    expect(coerceFrontmatterBoolean(fm.a)).toBe(true);
    expect(coerceFrontmatterBoolean(fm.b)).toBe(false);
    expect(coerceFrontmatterBoolean(fm.c)).toBe(true);
    expect(coerceFrontmatterBoolean(fm.d)).toBe(true);
  });

  it("returns undefined for values that are not boolean-ish", () => {
    // Not `false`. "Absent", "unparseable" and "explicitly off" are three
    // different states and only the caller knows which default it wants.
    for (const junk of ["maybe", "", 2, -1, null, undefined, {}, []]) {
      expect(coerceFrontmatterBoolean(junk)).toBeUndefined();
    }
  });

  it("confirms YAML itself does not do this for us", () => {
    // Guards the premise. If js-yaml ever switched to the YAML 1.1 schema,
    // `on` would arrive as a boolean and the coercion above would be dead code
    // — worth knowing, rather than silently keeping a redundant layer.
    expect(yaml.load("v: on")).toEqual({ v: "on" });
    expect(yaml.load("v: yes")).toEqual({ v: "yes" });
    expect(yaml.load("v: true")).toEqual({ v: true });
  });
});

// ── Hook event parity ────────────────────────────────────────────────────────

describe("C4 — hook event coverage", () => {
  it("includes the events added since Minder's list was written", () => {
    // DirectoryAdded is the one the plan named; the others were found by
    // diffing against the hooks reference and were being rejected with a 400.
    for (const event of [
      "DirectoryAdded",
      "PostCompact",
      "SubagentStart",
      "PermissionDenied",
      "FileChanged",
      "TaskCompleted",
      "WorktreeCreate",
    ]) {
      expect(HOOK_EVENT_NAMES).toContain(event);
    }
  });

  it("keeps every previously-known event", () => {
    // A regression here would silently stop accepting hooks users already have
    // configured, which is worse than never having supported the new ones.
    for (const event of [
      "PreToolUse", "PostToolUse", "UserPromptSubmit", "Notification",
      "Stop", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
    ]) {
      expect(HOOK_EVENT_NAMES).toContain(event);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(HOOK_EVENT_NAMES).size).toBe(HOOK_EVENT_NAMES.length);
  });

  it("parses DirectoryAdded into its documented fields", () => {
    const payload = parseHookPayload(
      {
        transcript_path: "/t.jsonl",
        directory: "/Users/my-other-repo",
        source: "slash_command",
      },
      "DirectoryAdded"
    );
    expect(payload).toMatchObject({
      kind: "DirectoryAdded",
      directory: "/Users/my-other-repo",
      source: "slash_command",
    });
  });

  it("rejects an unknown DirectoryAdded source rather than passing it through", () => {
    const payload = parseHookPayload({ source: "telepathy" }, "DirectoryAdded");
    expect(payload).toMatchObject({ kind: "DirectoryAdded", source: undefined });
  });

  it("captures an unmodelled event generically instead of dropping it", () => {
    const payload = parseHookPayload(
      { transcript_path: "/t.jsonl", file_path: "/repo/x.ts" },
      "FileChanged"
    );
    // The point of the catch-all: recorded, attributable to its event, and
    // carrying the raw body rather than a guessed projection of it.
    expect(payload).toMatchObject({ kind: "Generic", event: "FileChanged" });
    expect((payload as { raw: Record<string, unknown> }).raw.file_path).toBe("/repo/x.ts");
    expect(payload).not.toBeNull();
  });

  it("still models the detailed events rather than falling through to Generic", () => {
    const payload = parseHookPayload({ tool_name: "Bash" }, "PreToolUse");
    expect(payload).toMatchObject({ kind: "PreToolUse", toolName: "Bash" });
  });

  it("still rejects a typed payload missing its required field", () => {
    // The catch-all must not swallow malformed input for events that DO have
    // required fields — `default:` sits after every typed case for this reason.
    expect(parseHookPayload({}, "PreToolUse")).toBeNull();
  });
});

// ── Plugin skills roots ──────────────────────────────────────────────────────

describe("C4 — plugin skills path resolution", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pm-c4-plugin-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  async function writeManifest(skills: unknown): Promise<void> {
    const dir = path.join(tmp, ".claude-plugin");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify({ skills }));
  }

  it("defaults to <plugin>/skills when the manifest says nothing", async () => {
    expect(await resolvePluginSkillsRoots(tmp)).toEqual([path.resolve(tmp, "skills")]);
  });

  it('resolves "." to the plugin root', async () => {
    await writeManifest(".");
    // Additive: the plugin root joins the conventional `skills/` dir.
    expect(await resolvePluginSkillsRoots(tmp)).toEqual([
      path.resolve(tmp, "skills"),
      path.resolve(tmp),
    ]);
  });

  it("accepts an array of paths", async () => {
    await writeManifest(["skills", "extra/skills"]);
    // `skills` is declared AND implicit — deduped to one entry.
    expect(await resolvePluginSkillsRoots(tmp)).toEqual([
      path.resolve(tmp, "skills"),
      path.resolve(tmp, "extra/skills"),
    ]);
  });

  it("keeps the default skills/ root when custom paths are declared", async () => {
    // Codex review of #384: replacing the default was a regression. A plugin
    // with both `skills/foo/SKILL.md` and a declared `extra` path would have
    // had its standard skills silently dropped — skills the walk listed
    // correctly before this feature existed.
    await writeManifest("extra");
    const roots = await resolvePluginSkillsRoots(tmp);
    expect(roots).toContain(path.resolve(tmp, "skills"));
    expect(roots).toContain(path.resolve(tmp, "extra"));
  });

  it("refuses a path that escapes the plugin directory", async () => {
    await writeManifest(["../../../etc", "skills"]);
    const roots = await resolvePluginSkillsRoots(tmp);
    expect(roots).toEqual([path.resolve(tmp, "skills")]);
  });
});

// ── End-to-end through the skill walker ──────────────────────────────────────

describe("C4 — skill frontmatter reaches the catalog entry", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  // Must be complete: `resolveProvenance` reads `lockfile` and `marketplaceRepo`
  // as Maps, and a partial context throws inside the walker rather than
  // degrading.
  const ctx: ProvenanceContext = {
    installedPlugins: [],
    lockfile: new Map(),
    marketplaceRepo: new Map(),
  };

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-c4-skills-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  async function writeSkill(slug: string, frontmatter: string): Promise<void> {
    const dir = path.join(tmpHome, ".claude", "skills", slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${slug}\n${frontmatter}\n---\n\nBody.`
    );
  }

  it("treats `user-invocable: yes` as invocable", async () => {
    // The live bug: the reader compared against `true` and the string "true"
    // only, so this skill was excluded from the launcher chips entirely.
    await writeSkill("yes-skill", "user-invocable: yes");
    const skills = await walkUserSkills(ctx);
    expect(skills.find((s) => s.slug === "yes-skill")?.userInvocable).toBe(true);
  });

  it("treats an absent flag as invocable, which is Claude Code's default", async () => {
    // This test previously asserted the opposite and was pinning a bug. The
    // skills reference is explicit: "By default, both users and Claude can
    // invoke any skill", and `user-invocable: false` is what HIDES a skill from
    // the `/` menu. Minder's `?? false` inverted that, so every skill silent on
    // the key was withheld from the launcher chips (Codex review, #384).
    //
    // A test agreeing with the implementation is not evidence the
    // implementation is right — both were written from the same wrong
    // assumption.
    await writeSkill("quiet-skill", "description: nothing declared");
    const skills = await walkUserSkills(ctx);
    expect(skills.find((s) => s.slug === "quiet-skill")?.userInvocable).toBe(true);
  });

  it("still honours an explicit `user-invocable: false`", async () => {
    await writeSkill("hidden-skill", "user-invocable: false");
    const skills = await walkUserSkills(ctx);
    expect(skills.find((s) => s.slug === "hidden-skill")?.userInvocable).toBe(false);
  });

  it("captures the 2.1.218 keys, including `on` as a boolean", async () => {
    await writeSkill(
      "modern-skill",
      [
        "user-invocable: true",
        "disable-model-invocation: on",
        "background: 1",
        "context: fork",
        "effort: high",
        "model: claude-opus-5",
      ].join("\n")
    );
    const entry = (await walkUserSkills(ctx)).find((s) => s.slug === "modern-skill");
    expect(entry).toMatchObject({
      disableModelInvocation: true,
      background: true,
      context: "fork",
      effort: "high",
      model: "claude-opus-5",
    });
  });

  it("leaves undeclared keys undefined rather than false", async () => {
    await writeSkill("sparse-skill", "description: only a description");
    const entry = (await walkUserSkills(ctx)).find((s) => s.slug === "sparse-skill");
    // "did not declare it" and "declared it off" must stay distinguishable —
    // only the second should render a badge.
    expect(entry?.disableModelInvocation).toBeUndefined();
    expect(entry?.background).toBeUndefined();
  });

  it("does not list a skill twice when a declared root nests inside skills/", async () => {
    // The additive-roots fix made `skills/` always a candidate, so a declared
    // path underneath it is walked twice (Codex review of #384).
    const pluginPath = path.join(tmpHome, "plugins", "nested-plugin");
    await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: "./skills/foo" })
    );
    await fs.mkdir(path.join(pluginPath, "skills", "foo"), { recursive: true });
    await fs.writeFile(
      path.join(pluginPath, "skills", "foo", "SKILL.md"),
      "---\nname: nested-skill\n---\n\nBody."
    );

    const pluginCtx = {
      ...ctx,
      installedPlugins: [{ pluginName: "nested-plugin", installPath: pluginPath }],
    } as unknown as ProvenanceContext;

    const skills = await walkPluginSkills(pluginCtx);
    expect(skills.filter((s) => s.name === "nested-skill")).toHaveLength(1);
  });

  it('finds a plugin whose manifest declares `"skills": "."`', async () => {
    const pluginPath = path.join(tmpHome, "plugins", "one-skill-plugin");
    await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: "." })
    );
    await fs.writeFile(
      path.join(pluginPath, "SKILL.md"),
      "---\nname: root-skill\nuser-invocable: yes\n---\n\nBody."
    );

    const pluginCtx = {
      ...ctx,
      installedPlugins: [{ pluginName: "one-skill-plugin", installPath: pluginPath }],
    } as unknown as ProvenanceContext;

    const skills = await walkPluginSkills(pluginCtx);
    expect(skills.map((s) => s.name)).toContain("root-skill");
    expect(skills.find((s) => s.name === "root-skill")?.userInvocable).toBe(true);
  });

  it("gives distinct skills distinct ids when two roots share a directory name", async () => {
    // The path dedupe added last round handles the same FILE found twice. This
    // is two different files whose ids collide, because the id is derived from
    // the directory basename — every id-keyed consumer would then resolve the
    // wrong one (Codex review, #384).
    const pluginPath = path.join(tmpHome, "plugins", "twin-plugin");
    await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: ["./extra"] })
    );
    for (const root of ["skills", "extra"]) {
      await fs.mkdir(path.join(pluginPath, root, "helper"), { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, root, "helper", "SKILL.md"),
        `---\nname: ${root}-helper\n---\n\nBody.`
      );
    }

    const pluginCtx = {
      ...ctx,
      installedPlugins: [{ pluginName: "twin-plugin", installPath: pluginPath }],
    } as unknown as ProvenanceContext;

    const skills = await walkPluginSkills(pluginCtx);
    const helpers = skills.filter((s) => s.name.endsWith("-helper"));
    expect(helpers).toHaveLength(2);
    expect(new Set(helpers.map((s) => s.id)).size).toBe(2);
  });

  // `t`, not `ctx` — the provenance context in this describe is already named
  // `ctx`, and shadowing it makes `...ctx` spread the Vitest test context.
  it("dedupes a symlinked skill reached through two roots", async (t) => {
    // `skills/foo -> ../extra/foo` with `extra` also declared: two lexical
    // paths, one real file. Keying the dedupe on filePath kept both and the
    // catalog showed duplicate rows with inflated counts. The walker already
    // records the canonical target as realPath (Codex review, #384).
    const pluginPath = path.join(tmpHome, "plugins", "symlink-plugin");
    await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginPath, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: ["./extra"] })
    );
    await fs.mkdir(path.join(pluginPath, "extra", "foo"), { recursive: true });
    await fs.writeFile(
      path.join(pluginPath, "extra", "foo", "SKILL.md"),
      "---\nname: linked-skill\n---\n\nBody."
    );
    await fs.mkdir(path.join(pluginPath, "skills"), { recursive: true });
    try {
      await fs.symlink(
        path.join(pluginPath, "extra", "foo"),
        path.join(pluginPath, "skills", "foo"),
        "junction"
      );
    } catch {
      // No symlink privilege here. Report SKIPPED, never passed: the earlier
      // `return` made this test vacuously green on the author's machine while
      // the fix it covers was broken, and only CI's Windows runner — which can
      // create the junction — found out (#392).
      t.skip();
      return;
    }

    const pluginCtx = {
      ...ctx,
      installedPlugins: [{ pluginName: "symlink-plugin", installPath: pluginPath }],
    } as unknown as ProvenanceContext;

    const skills = await walkPluginSkills(pluginCtx);
    expect(skills.filter((s) => s.name === "linked-skill")).toHaveLength(1);
  });

  it("leaves ids alone when there is no collision", async () => {
    // Qualifying unconditionally would churn ids that appear in URLs.
    const pluginPath = path.join(tmpHome, "plugins", "plain-plugin");
    await fs.mkdir(path.join(pluginPath, "skills", "solo"), { recursive: true });
    await fs.writeFile(
      path.join(pluginPath, "skills", "solo", "SKILL.md"),
      "---\nname: solo\n---\n\nBody."
    );

    const pluginCtx = {
      ...ctx,
      installedPlugins: [{ pluginName: "plain-plugin", installPath: pluginPath }],
    } as unknown as ProvenanceContext;

    const skills = await walkPluginSkills(pluginCtx);
    expect(skills.find((s) => s.name === "solo")?.id).toBe(
      "skill:plugin:plain-plugin:bundled:solo"
    );
  });
});

describe("C4 — hook events that resolve or fail a turn", () => {
  it("treats PostToolUseFailure as a failure even with no failure fields", async () => {
    // Claude Code emits this event INSTEAD of PostToolUse when a call fails, so
    // the payload need not repeat is_error/return_code. Scanning only for
    // PostToolUse walked past it to an older successful call and reported "no
    // recent failure" from a buffer whose newest entry was one (Codex, #384).
    const { hasRecentToolFailure } = await import("@/lib/agentView/aggregate");
    const now = Date.now();
    const events = [
      { hookEventName: "PostToolUse", toolFailed: undefined, receivedAt: now - 5_000 },
      { hookEventName: "PostToolUseFailure", toolFailed: true, receivedAt: now - 1_000 },
    ] as unknown as Parameters<typeof hasRecentToolFailure>[0];

    expect(hasRecentToolFailure(events, now)).toBe(true);
  });

  it("still reports no failure when the newest completion succeeded", async () => {
    const { hasRecentToolFailure } = await import("@/lib/agentView/aggregate");
    const now = Date.now();
    const events = [
      { hookEventName: "PostToolUseFailure", toolFailed: true, receivedAt: now - 5_000 },
      { hookEventName: "PostToolUse", toolFailed: undefined, receivedAt: now - 1_000 },
    ] as unknown as Parameters<typeof hasRecentToolFailure>[0];

    expect(hasRecentToolFailure(events, now)).toBe(false);
  });

  it("counts PermissionDenied as a response to a prompt", async () => {
    // A denial conclusively ends the prompt. Leaving it out kept the project
    // pinned in the awaiting UI until the five-minute eviction, because the
    // events that would clear it only arrive if the user does something ELSE
    // afterwards (Codex review, #384).
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "app", "api", "hooks", "route.ts"),
      "utf-8"
    );
    const allowlist = source.slice(
      source.indexOf("const RESPONSE_EVENTS"),
      source.indexOf("]);", source.indexOf("const RESPONSE_EVENTS"))
    );
    expect(allowlist).toContain('"PermissionDenied"');
    // The passive events must stay OUT — that was the original finding.
    for (const passive of ["FileChanged", "TeammateIdle", "TaskCompleted", "ConfigChange"]) {
      expect(allowlist).not.toContain(`"${passive}"`);
    }
  });
});
