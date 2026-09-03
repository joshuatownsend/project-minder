import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { environmentHomeKey, readHomeInventory } from "@/lib/environments/inventory";
import { normalizePathKey } from "@/lib/platform";
import { resolveUsageHomeKey } from "@/lib/usage/projectMatch";

let tmp: string;
let home: string;
let linked = false;

async function write(rel: string, content: string) {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "minder-env-"));
  home = path.join(tmp, ".claude");
  await write(".claude/agents/reviewer.md", "---\nname: Reviewer\n---\nbody");
  await write(".claude/agents/nested/planner.md", "no frontmatter");
  await write(".claude/agents/.hidden.md", "---\nname: hidden\n---");
  await write(".claude/agents/notes.txt", "ignored");
  // The sibling ~/.agents/agents layout: one new agent, one colliding slug
  // (the .claude copy must win), and a tree deeper than the walker's cap.
  await write(".agents/agents/installed-only.md", "---\nname: Installed\n---");
  await write(".agents/agents/reviewer.md", "---\nname: Shadowed\n---");
  await write(".agents/agents/a/b/c/d/e/f/g/too-deep.md", "");
  await write(".claude/skills/pr-resolve/SKILL.md", "---\nname: PR Resolve\n---");
  await write(".claude/skills/not-a-skill/README.md", "no SKILL.md here");
  await write(".claude/skills/standalone.md", "---\nname: Standalone\n---");
  await write(".claude/skills-disabled/legacy/SKILL.md", "");
  // A skill installed by linking a directory into skills/. A junction needs no
  // privilege on Windows and is a symlink on POSIX; skip silently where even
  // that is refused so the rest of the suite still runs.
  await write("elsewhere/linked-skill/SKILL.md", "---\nname: Linked\n---");
  try {
    await fs.symlink(path.join(tmp, "elsewhere", "linked-skill"), path.join(home, "skills", "linked-skill"), "junction");
    linked = true;
  } catch {
    linked = false;
  }
  await write(
    ".claude/plugins/installed_plugins.json",
    JSON.stringify({
      plugins: {
        "github@official": [
          { version: "1.2.0", installPath: "/home/me/.claude/plugins/github" },
          { version: "1.10.0", installPath: "/home/me/.claude/plugins/github-new" },
        ],
        "pre@m": [{ version: "2.0.0-beta.1" }, { version: "2.0.0" }, { version: "1.9.9" }],
        "rc@m": [{ version: "3.0.0-beta.2" }, { version: "3.0.0-beta.10" }],
        "@scope/tool@community": [{ installPath: "/x" }],
        "empty@m": [],
      },
    })
  );
  await write(
    ".claude/settings.json",
    JSON.stringify({ mcpServers: { "from-settings": { command: "x", env: { KEY: "secret" } } } })
  );
  await write(".claude.json", JSON.stringify({ mcpServers: { "from-claude-json": {}, "from-settings": {} } }));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("readHomeInventory", () => {
  it("lists agents recursively with frontmatter names, skipping dotfiles and non-markdown", async () => {
    const inv = await readHomeInventory(home, true);
    expect(inv.agents).toEqual([
      { slug: "installed-only", name: "Installed" },
      { slug: "nested/planner", name: undefined },
      // Present in both roots: the .claude copy wins, like loadCatalog.
      { slug: "reviewer", name: "Reviewer" },
    ]);
    // 7 levels down is past the depth cap.
    expect(inv.agents.some((a) => a.slug.endsWith("too-deep"))).toBe(false);
  });

  it("lists bundled and standalone skills, marking the disabled root", async () => {
    const inv = await readHomeInventory(home, true);
    expect(inv.skills.filter((s) => s.slug !== "linked-skill")).toEqual([
      { slug: "legacy", name: undefined, disabled: true },
      { slug: "pr-resolve", name: "PR Resolve", disabled: false },
      { slug: "standalone", name: "Standalone", disabled: false },
    ]);
  });

  it("follows a directory link in skills/ like the catalog walker does", async () => {
    if (!linked) return; // link creation refused on this machine
    const inv = await readHomeInventory(home, true);
    expect(inv.skills.find((s) => s.slug === "linked-skill")).toEqual({ slug: "linked-skill", name: "Linked", disabled: false });
  });

  it("reads plugins from the registry only, highest version wins, scoped names intact", async () => {
    const inv = await readHomeInventory(home, true);
    expect(inv.plugins).toEqual([
      { id: "@scope/tool@community", name: "@scope/tool", marketplace: "community", version: undefined },
      { id: "github@official", name: "github", marketplace: "official", version: "1.10.0" },
      // Stable beats pre-release at equal numbers, like loadInstalledPlugins.
      { id: "pre@m", name: "pre", marketplace: "m", version: "2.0.0" },
      // Pre-release identifiers compare numerically: beta.10 > beta.2.
      { id: "rc@m", name: "rc", marketplace: "m", version: "3.0.0-beta.10" },
    ]);
  });

  it("emits MCP server names from both sources, deduplicated, and never their config", async () => {
    const inv = await readHomeInventory(home, true);
    expect(inv.mcpServers).toEqual(["from-claude-json", "from-settings"]);
    expect(JSON.stringify(inv)).not.toContain("secret");
  });

  it("keys the home the way the scanner keys usageHomeKey", async () => {
    const inv = await readHomeInventory(home, true);
    expect(inv.key).toBe(normalizePathKey(home));
    expect(inv.primary).toBe(true);
  });

  it("rejects array-shaped plugins and mcpServers instead of emitting indices", async () => {
    const bad = path.join(tmp, "bad", ".claude");
    await write("bad/.claude/plugins/installed_plugins.json", JSON.stringify({ plugins: [{ version: "1.0.0" }] }));
    await write("bad/.claude/settings.json", JSON.stringify({ mcpServers: ["a", "b"] }));
    await write("bad/.claude.json", JSON.stringify({ mcpServers: ["c"] }));
    const inv = await readHomeInventory(bad, false);
    expect(inv.plugins).toEqual([]);
    expect(inv.mcpServers).toEqual([]);
  });

  it("returns empty lists for a home that does not exist", async () => {
    const inv = await readHomeInventory(path.join(tmp, "missing", ".claude"), false);
    expect(inv).toMatchObject({ agents: [], skills: [], plugins: [], mcpServers: [], primary: false });
  });
});

describe("home key join", () => {
  it("a mapped WSL project's usageHomeKey equals the inventory key of its home", () => {
    // Pure: no filesystem call touches a `\\wsl.localhost\` path here (that
    // would auto-start the distro — the never-wake rule).
    const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude";
    const projectPath = "\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\foo";
    const usageKey = resolveUsageHomeKey(
      projectPath,
      [{ from: "/home/me", to: "\\\\wsl.localhost\\Ubuntu\\home\\me" }],
      [wslHome]
    );
    expect(usageKey).toBeDefined();
    expect(environmentHomeKey(wslHome)).toBe(usageKey);
    expect(environmentHomeKey("\\\\wsl$\\Ubuntu\\home\\me\\.claude")).toBe(usageKey);
  });
});
