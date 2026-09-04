import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { environmentHomeKey, readHomeInventory } from "@/lib/environments/inventory";
import { normalizePathKey } from "@/lib/platform";
import { resolveUsageHomeKey } from "@/lib/usage/projectMatch";

/**
 * Since #553 the inventory is the part of a home the catalog does not
 * cover: plugins from the registry, MCP server names, and the join key. The
 * agents/skills walks moved to the catalog (`tests/catalogHomeWalkers.test.ts`).
 */
let tmp: string;
let home: string;

async function write(rel: string, content: string) {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "minder-env-"));
  home = path.join(tmp, ".claude");
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
        // Highest version's path is unmapped, an older install's is mapped.
        "split@m": [
          { version: "2.0.0", installPath: "/opt/split" },
          { version: "1.0.0", installPath: "/home/me/.claude/plugins/split" },
        ],
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
  it("reads plugins from the registry only, highest version wins, scoped names intact", async () => {
    const inv = await readHomeInventory(home, true);
    expect(inv.plugins).toEqual([
      { id: "@scope/tool@community", name: "@scope/tool", marketplace: "community", version: undefined },
      { id: "github@official", name: "github", marketplace: "official", version: "1.10.0" },
      // Stable beats pre-release at equal numbers, like loadInstalledPlugins.
      { id: "pre@m", name: "pre", marketplace: "m", version: "2.0.0" },
      // Pre-release identifiers compare numerically: beta.10 > beta.2.
      { id: "rc@m", name: "rc", marketplace: "m", version: "3.0.0-beta.10" },
      { id: "split@m", name: "split", marketplace: "m", version: "2.0.0" },
    ]);
  });

  it("never flags a primary home's plugins as unreadable", async () => {
    const inv = await readHomeInventory(home, true);
    expect(inv.plugins.some((p) => p.unresolved)).toBe(false);
  });

  it("flags a foreign home's plugins as unreadable when no mapping covers their install path", async () => {
    // Same registry read as a non-primary home: the POSIX install paths are
    // the home's own, and without a mapping this machine cannot open them.
    const inv = await readHomeInventory(home, false);
    const byId = Object.fromEntries(inv.plugins.map((p) => [p.id, p]));
    if (process.platform === "win32") {
      expect(byId["github@official"].unresolved).toBe(true);
      expect(byId["@scope/tool@community"].unresolved).toBe(true);
    }
    // An entry with no install path at all has nothing to resolve.
    expect(byId["pre@m"].unresolved).toBeUndefined();
  });

  it("does not flag them once a mapping rewrites the install path", async () => {
    const inv = await readHomeInventory(home, false, [{ from: "/home/me", to: path.join(tmp, "mapped") }]);
    const gh = inv.plugins.find((p) => p.id === "github@official")!;
    expect(gh.unresolved).toBeUndefined();
    // `/x` is outside the mapping and stays unreadable on a Windows host.
    const tool = inv.plugins.find((p) => p.id === "@scope/tool@community")!;
    expect(tool.unresolved).toBe(process.platform === "win32" ? true : undefined);
  });

  it("judges readability from the install the catalog reads — the highest version — not from any record", async () => {
    // `split@m`: 2.0.0 lives at an unmapped `/opt/split`, 1.0.0 under the
    // mapped `/home/me`. The catalog walks 2.0.0 only, so the tab must say
    // unreadable even though an older install would have been reachable
    // (Copilot + Codex on #555).
    const inv = await readHomeInventory(home, false, [{ from: "/home/me", to: path.join(tmp, "mapped") }]);
    const split = inv.plugins.find((p) => p.id === "split@m")!;
    expect(split.version).toBe("2.0.0");
    expect(split.unresolved).toBe(process.platform === "win32" ? true : undefined);
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

  it("carries no agents or skills — those come from the catalog per home", async () => {
    const inv = await readHomeInventory(home, true);
    expect("agents" in inv).toBe(false);
    expect("skills" in inv).toBe(false);
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
    expect(inv).toMatchObject({ plugins: [], mcpServers: [], primary: false });
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
