import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { lintFingerprint } from "@/lib/lint/resultCache";

// #617 — files a config file POINTS AT are inputs to the lint result even though nothing walks to
// them: the CLI `stat`s (and for `@imports`, reads and follows) whatever a CLAUDE.md imports and
// whatever a SKILL.md links to, including targets outside the project. The fingerprint has to move
// when any of those appears, changes or disappears.
//
// Traced against claude-code-lint 0.10.0 (see lintFingerprintConformance.test.ts): the CLI does NOT
// read any .gitignore, global or otherwise, so a global gitignore is not an input.

let root: string;
let project: string;

const at = (rel: string) => path.join(project, rel);
function write(rel: string, content: string) {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), content);
}
const fp = () => lintFingerprint(project, "1.0.0");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-refs-"));
  project = path.join(root, "proj");
  fs.mkdirSync(project);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("@imports in a CLAUDE.md", () => {
  it("changes when an imported file is created", async () => {
    write("CLAUDE.md", "# p\n@docs/extra.md\n");
    const before = await fp();
    write("docs/extra.md", "extra\n");
    expect(await fp()).not.toBe(before);
  });

  it("changes when an imported file is edited", async () => {
    write("CLAUDE.md", "# p\n@docs/extra.md\n");
    write("docs/extra.md", "one\n");
    const before = await fp();
    write("docs/extra.md", "two\n");
    expect(await fp()).not.toBe(before);
  });

  it("changes when an imported file is deleted", async () => {
    write("CLAUDE.md", "# p\n@docs/extra.md\n");
    write("docs/extra.md", "one\n");
    const before = await fp();
    fs.rmSync(at("docs/extra.md"));
    expect(await fp()).not.toBe(before);
  });

  it("follows an import that points OUTSIDE the project", async () => {
    write("CLAUDE.md", "# p\n@../shared.md\n");
    const before = await fp();
    fs.writeFileSync(path.join(root, "shared.md"), "shared\n");
    const created = await fp();
    expect(created).not.toBe(before);
    fs.writeFileSync(path.join(root, "shared.md"), "changed\n");
    expect(await fp()).not.toBe(created);
  });

  it("follows a chain: editing a file imported BY an imported file changes it", async () => {
    write("CLAUDE.md", "@a.md\n");
    write("a.md", "@b.md\n");
    write("b.md", "leaf one\n");
    const before = await fp();
    write("b.md", "leaf two\n");
    expect(await fp()).not.toBe(before);
  });

  it("resolves a nested import against the importing file's directory", async () => {
    write("CLAUDE.md", "@docs/a.md\n");
    write("docs/a.md", "@sub/b.md\n");
    const before = await fp();
    write("docs/sub/b.md", "now it exists\n");
    expect(await fp()).not.toBe(before);
  });

  it("terminates on a circular import", async () => {
    write("CLAUDE.md", "@a.md\n");
    write("a.md", "@b.md\n");
    write("b.md", "@a.md\n");
    expect(await fp()).not.toBeNull();
  });

  it("tracks an import in a rules file and in a nested CLAUDE.md", async () => {
    write(".claude/rules/style.md", "@../../docs/style-guide.md\n");
    write("packages/x/CLAUDE.md", "@notes/x.md\n");
    const before = await fp();
    write("docs/style-guide.md", "s\n");
    const afterRule = await fp();
    expect(afterRule).not.toBe(before);
    write("packages/x/notes/x.md", "x\n");
    expect(await fp()).not.toBe(afterRule);
  });

  it("tracks a directory standing where an import points", async () => {
    write("CLAUDE.md", "@docs/extra.md\n");
    const before = await fp();
    fs.mkdirSync(at("docs/extra.md"), { recursive: true });
    expect(await fp()).not.toBe(before);
  });

  it("resolves '~/' like the CLI does: relative to the importing file, not the home directory", async () => {
    write("CLAUDE.md", "@~/shared.md\n");
    const before = await fp();
    write("~/shared.md", "x\n");
    expect(await fp()).not.toBe(before);
  });

  it("ignores @-words that are not paths (decorators, JSDoc tags, mentions)", async () => {
    write("CLAUDE.md", "Use @Injectable and @param, ping @alice about it.\n");
    const before = await fp();
    write("Injectable", "x\n");
    write("alice", "x\n");
    // None of them is an import path, so creating files with those names changes nothing.
    // (Both writes land outside the config scope, so only a tracked import could move the hash.)
    expect(await fp()).toBe(before);
  });

  it("is uncacheable when an import chain is too large to track", async () => {
    write("CLAUDE.md", "@f0.md\n");
    for (let i = 0; i < 205; i++) write(`f${i}.md`, `@f${i + 1}.md\n`);
    expect(await fp()).toBeNull();
  });

  it("is uncacheable when a project names more import targets than are worth tracking", async () => {
    const tokens = Array.from({ length: 2100 }, (_, i) => `@refs/${i}.md`);
    write("CLAUDE.md", tokens.join("\n") + "\n");
    expect(await fp()).toBeNull();
  });

  it("is uncacheable when an imported file is too large to compare by content", async () => {
    write("CLAUDE.md", "@big.md\n");
    write("big.md", "x".repeat(2 * 1024 * 1024 + 1));
    expect(await fp()).toBeNull();
  });
});

describe("relative links in a SKILL.md", () => {
  const skill = (body: string) => write("skills/foo/SKILL.md", `---\nname: foo\ndescription: d\n---\n${body}\n`);

  it("changes when a linked file is created, and when it is deleted again", async () => {
    skill("See [ref](./ref.md).");
    const missing = await fp();
    write("skills/foo/ref.md", "r\n");
    const present = await fp();
    expect(present).not.toBe(missing);
    fs.rmSync(at("skills/foo/ref.md"));
    expect(await fp()).toBe(missing);
  });

  it("follows a link that points OUTSIDE the project", async () => {
    skill("See [out](../../../outside.md).");
    const before = await fp();
    fs.writeFileSync(path.join(root, "outside.md"), "o\n");
    expect(await fp()).not.toBe(before);
  });

  it("follows a bare relative link and a nested one", async () => {
    skill("See [a](a.md) and [b](references/deep.md).");
    const before = await fp();
    write("skills/foo/a.md", "a\n");
    const afterA = await fp();
    expect(afterA).not.toBe(before);
    write("skills/foo/references/deep.md", "d\n");
    expect(await fp()).not.toBe(afterA);
  });

  it("only needs the link's target to EXIST: editing it leaves the fingerprint alone", async () => {
    // The target sits outside every config scope, so only the link tracking can see it (a file
    // beside SKILL.md would also be hashed by the tree walk).
    skill("See [out](../../../outside.md).");
    fs.writeFileSync(path.join(root, "outside.md"), "one\n");
    const before = await fp();
    fs.writeFileSync(path.join(root, "outside.md"), "two\n");
    expect(await fp()).toBe(before);
  });

  it("does not track URLs, anchors, absolute paths or mailto links", async () => {
    skill("[a](https://example.com/x.md) [b](#top) [c](/etc/hosts) [d](mailto:a@b.c)");
    const before = await fp();
    fs.writeFileSync(path.join(root, "x.md"), "x\n");
    expect(await fp()).toBe(before);
  });

  it("does not track links in a markdown file that is not a SKILL.md", async () => {
    write("skills/foo/NOTES.md", "See [out](../../../outside.md).\n");
    skill("no links here");
    const before = await fp();
    fs.writeFileSync(path.join(root, "outside.md"), "o\n");
    expect(await fp()).toBe(before);
  });
});

describe("apiKeyHelper in a settings file", () => {
  const settings = (text: string) => write(".claude/settings.json", text);

  it("is uncacheable when the key is written plainly", async () => {
    settings('{"apiKeyHelper":"./get-key.sh"}');
    expect(await fp()).toBeNull();
  });

  it("is uncacheable when the key is written with a JSON escape (the CLI parses it as the same key)", async () => {
    settings('{"apiKey\\u0048elper":"./get-key.sh"}');
    expect(await fp()).toBeNull();
  });

  it("is uncacheable when the key is nested", async () => {
    settings('{"env":{"x":[{"apiKeyHelper":"./k.sh"}]}}');
    expect(await fp()).toBeNull();
  });

  it("is uncacheable when the file does not parse and contains an escape", async () => {
    settings('{"apiKey\\u0048elper": "./k.sh",}');
    expect(await fp()).toBeNull();
  });

  it("is cacheable when the word only appears in a value", async () => {
    settings('{"note":"remember to set apiKeyHelper later"}');
    expect(await fp()).not.toBeNull();
  });
});

describe("a reference target that cannot be inspected", () => {
  /** Make `stat` of one path fail with `code`, as the CLI's own `stat` of it would. */
  function failStat(target: string, code: string) {
    const real = fs.promises.stat.bind(fs.promises);
    return vi.spyOn(fs.promises, "stat").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === target) return Promise.reject(Object.assign(new Error(code), { code }));
      return (real as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
    }) as typeof fs.promises.stat);
  }

  it("is uncacheable when an imported file's permissions block the stat", async () => {
    write("CLAUDE.md", "@docs/extra.md\n");
    const spy = failStat(at("docs/extra.md"), "EACCES");
    try {
      expect(await fp()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("is uncacheable when a skill link's target cannot be stat'ed", async () => {
    write("skills/foo/SKILL.md", "---\nname: foo\ndescription: d\n---\n[x](./ref.md)\n");
    const spy = failStat(at("skills/foo/ref.md"), "EIO");
    try {
      expect(await fp()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["ENOENT", "ENOTDIR", "EINVAL", "ENAMETOOLONG", "ELOOP"])(
    "treats %s as absent, which is what the CLI's fileExists does with any failed stat",
    async (code) => {
      write("CLAUDE.md", "@docs/extra.md\n");
      const spy = failStat(at("docs/extra.md"), code);
      try {
        expect(await fp()).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    },
  );
});
