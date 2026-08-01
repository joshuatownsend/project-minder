import { describe, it, expect, afterAll } from "vitest";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { detectDrift } from "@/lib/drift/compare";
import { codexMcpItems, geminiMcpItems, listSkills, listRules } from "@/lib/drift/inventory";
import type { DriftItem, DriftKind, HarnessInventory } from "@/lib/drift/types";

function item(kind: DriftKind, name: string, signature?: string): DriftItem {
  return { kind, key: name.toLowerCase(), name, signature };
}

function inv(over: Partial<HarnessInventory> & { harness: HarnessInventory["harness"] }): HarnessInventory {
  return {
    displayName: over.harness,
    present: true,
    supports: ["mcp", "skill", "instruction"],
    items: [],
    home: `/home/.${over.harness}`,
    ...over,
  };
}

// ─── Silence conditions ──────────────────────────────────────────────────────

describe("detectDrift stays silent when there is nothing to compare", () => {
  it("returns nothing for a single harness", () => {
    // The default `enabledAdapters` is ["claude"], so this is the common case:
    // the feature must cost a solo-harness user exactly zero findings.
    expect(detectDrift([inv({ harness: "claude", items: [item("skill", "a")] })])).toEqual([]);
  });

  it("ignores a harness whose config home does not exist", () => {
    const findings = detectDrift([
      inv({ harness: "claude", items: [item("skill", "a")] }),
      inv({ harness: "codex", present: false }),
    ]);
    expect(findings).toEqual([]);
  });

  it("skips a kind the other harness has no concept of", () => {
    // Reporting "12 MCP servers missing" against a harness that cannot hold
    // MCP servers describes the harness, not something the user can fix.
    const shared = [item("skill", "a")];
    const findings = detectDrift([
      inv({ harness: "claude", items: [item("mcp", "neon"), ...shared] }),
      inv({ harness: "gemini", supports: ["skill"], items: shared.map((i) => ({ ...i })) }),
    ]);
    // The skills match, and `mcp` has only one participating harness — so the
    // Claude-only MCP server produces nothing rather than a bogus gap.
    expect(findings).toEqual([]);
  });

  it("returns nothing when the two harnesses agree", () => {
    const items = [item("skill", "hyperframes"), item("mcp", "neon", "npx neon")];
    expect(
      detectDrift([
        inv({ harness: "claude", items }),
        inv({ harness: "codex", items: items.map((i) => ({ ...i })) }),
      ]),
    ).toEqual([]);
  });
});

// ─── Divergence is summarized ────────────────────────────────────────────────

describe("one-directional gaps collapse into a single finding", () => {
  const claudeSkills = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

  const findings = detectDrift([
    inv({
      harness: "claude",
      displayName: "Claude Code",
      items: claudeSkills.map((s) => item("skill", s)),
    }),
    inv({ harness: "codex", displayName: "Codex", home: "/home/.codex", items: [item("skill", "alpha")] }),
  ]);

  it("emits one finding, not one per missing item", () => {
    // On a real machine this is 49 skills. Per-item findings would bury
    // everything else in the lint report.
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("drift/skill-missing");
  });

  it("names the count and both harnesses in the title", () => {
    expect(findings[0].title).toBe("6 skills configured for Claude Code but not Codex");
  });

  it("samples five names and states the overflow rather than cutting silently", () => {
    expect(findings[0].fix).toContain("bravo, charlie, delta, echo, foxtrot");
    expect(findings[0].fix).toContain("and 1 more");
  });

  it("points at the target harness's home and says Minder will not write it", () => {
    expect(findings[0].fix).toContain("/home/.codex");
    expect(findings[0].fix).toContain("never writes harness config");
  });

  it("uses the singular noun for a gap of one", () => {
    const one = detectDrift([
      inv({ harness: "claude", displayName: "Claude Code", items: [item("skill", "solo")] }),
      inv({ harness: "codex", displayName: "Codex" }),
    ]);
    expect(one[0].title).toBe("1 skill configured for Claude Code but not Codex");
    expect(one[0].fix).not.toContain("more");
  });

  it("reports both directions when each harness has something the other lacks", () => {
    const both = detectDrift([
      inv({ harness: "claude", displayName: "Claude Code", items: [item("skill", "only-claude")] }),
      inv({ harness: "codex", displayName: "Codex", items: [item("skill", "only-codex")] }),
    ]);
    expect(both).toHaveLength(2);
    expect(both.map((f) => f.file).sort()).toEqual([
      "drift:skill:claude->codex",
      "drift:skill:codex->claude",
    ]);
  });

  it("compares each kind independently", () => {
    const mixed = detectDrift([
      inv({
        harness: "claude",
        items: [item("skill", "s1"), item("mcp", "m1"), item("instruction", "(root)")],
      }),
      inv({ harness: "codex", items: [item("instruction", "(root)")] }),
    ]);
    expect(mixed.map((f) => f.code).sort()).toEqual([
      "drift/mcp-missing",
      "drift/skill-missing",
    ]);
  });
});

// ─── Conflicts are per-item ──────────────────────────────────────────────────

describe("same name, different definition", () => {
  it("flags an MCP server whose launch command differs", () => {
    const findings = detectDrift([
      inv({ harness: "claude", displayName: "Claude Code", items: [item("mcp", "neon", "npx neon@2")] }),
      inv({ harness: "codex", displayName: "Codex", items: [item("mcp", "Neon", "npx neon@1")] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("drift/mcp-conflict");
    expect(findings[0].title).toContain("defined differently");
    expect(findings[0].fix).toContain("npx neon@2");
    expect(findings[0].fix).toContain("npx neon@1");
  });

  it("matches case-insensitively — the key is normalized, the name is not", () => {
    // "Neon" in one harness and "neon" in the other is the same server; a
    // case-sensitive compare would report it missing from both directions.
    const findings = detectDrift([
      inv({ harness: "claude", items: [item("mcp", "Neon", "same")] }),
      inv({ harness: "codex", items: [item("mcp", "neon", "same")] }),
    ]);
    expect(findings).toEqual([]);
  });

  it("stays quiet when only one side carries a signature", () => {
    // An unknown definition is not evidence of a different one.
    const findings = detectDrift([
      inv({ harness: "claude", items: [item("mcp", "neon", "npx neon")] }),
      inv({ harness: "codex", items: [item("mcp", "neon")] }),
    ]);
    expect(findings).toEqual([]);
  });

  it("never raises a conflict for skills, which carry no signature", () => {
    const findings = detectDrift([
      inv({ harness: "claude", items: [item("skill", "shared")] }),
      inv({ harness: "codex", items: [item("skill", "shared")] }),
    ]);
    expect(findings).toEqual([]);
  });

  it("emits one conflict per pair, not one per direction", () => {
    const findings = detectDrift([
      inv({ harness: "claude", items: [item("mcp", "neon", "a")] }),
      inv({ harness: "codex", items: [item("mcp", "neon", "b")] }),
      inv({ harness: "gemini", items: [item("mcp", "neon", "c")] }),
    ]);
    expect(findings.filter((f) => f.code === "drift/mcp-conflict")).toHaveLength(3);
  });
});

// ─── Report shape ────────────────────────────────────────────────────────────

describe("finding shape", () => {
  const findings = detectDrift([
    inv({ harness: "claude", items: [item("skill", "a"), item("mcp", "m", "x")] }),
    inv({ harness: "codex", items: [item("mcp", "m", "y")] }),
  ]);

  it("is advisory: every drift finding is P2 with zero penalty", () => {
    // `LintReport.hasBlocking` is any P0/P1. Enabling a second adapter must
    // not be able to fail someone's strict-lint gate on a parity observation.
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.severity).toBe("P2");
      expect(f.penalty).toBe(0);
      expect(f.target).toBe("drift");
      expect(f.engine).toBe("vendored");
    }
  });

  it("gives every finding a stable, distinct file key for dedupe", () => {
    const keys = findings.map((f) => f.file);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ─── Config parsing ──────────────────────────────────────────────────────────

describe("codexMcpItems", () => {
  it("reads [mcp_servers.*] into items with a command signature", () => {
    const items = codexMcpItems({
      mcp_servers: {
        Neon: { command: "npx", args: ["-y", "@neon/mcp"] },
        docs: { url: "https://example.test/mcp" },
      },
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "mcp", key: "neon", name: "Neon", signature: "npx -y @neon/mcp" });
    expect(items[1].signature).toBe("https://example.test/mcp");
  });

  it("returns nothing for absent, malformed, or non-object configs", () => {
    expect(codexMcpItems(null)).toEqual([]);
    expect(codexMcpItems({})).toEqual([]);
    expect(codexMcpItems({ mcp_servers: [] })).toEqual([]);
    expect(codexMcpItems({ mcp_servers: { bad: "not-a-table" } })).toEqual([]);
    expect(codexMcpItems("nope")).toEqual([]);
  });

  it("leaves the signature undefined when there is no command or url", () => {
    const items = codexMcpItems({ mcp_servers: { odd: { env: { A: "1" } } } });
    expect(items[0].signature).toBeUndefined();
  });

  it("ignores non-string args rather than stringifying them into the signature", () => {
    const items = codexMcpItems({ mcp_servers: { x: { command: "node", args: ["a", 7, null] } } });
    expect(items[0].signature).toBe("node a");
  });
});

describe("geminiMcpItems", () => {
  it("reads settings.json mcpServers", () => {
    const items = geminiMcpItems({ mcpServers: { fs: { command: "npx", args: ["fs-mcp"] } } });
    expect(items[0]).toMatchObject({ key: "fs", signature: "npx fs-mcp" });
  });

  it("tolerates a settings file with no mcpServers key at all", () => {
    // The real one on this machine has only `hooks`.
    expect(geminiMcpItems({ hooks: {} })).toEqual([]);
  });
});

// ─── Directory listing ───────────────────────────────────────────────────────

describe("listSkills / listRules", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
  });

  async function tmpdir(): Promise<string> {
    const dir = path.join(os.tmpdir(), `minder-drift-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    roots.push(dir);
    return dir;
  }

  it("counts bundled directories and standalone .md files alike", async () => {
    const dir = await tmpdir();
    await fs.mkdir(path.join(dir, "bundled"));
    await fs.writeFile(path.join(dir, "bundled", "SKILL.md"), "x");
    await fs.writeFile(path.join(dir, "standalone.md"), "x");
    await fs.writeFile(path.join(dir, "notes.txt"), "x");

    const names = (await listSkills(dir)).map((s) => s.name).sort();
    expect(names).toEqual(["bundled", "standalone"]);
  });

  it("follows a symlinked skill instead of dropping it", async () => {
    // 24 of 57 skills under ~/.claude/skills are stow-style links. readdir
    // reports those as isSymbolicLink() and never isDirectory(), so a plain
    // type check silently omits them — and an item missing from an inventory
    // gets reported as missing from that harness, which is a false positive
    // telling the user to install what they already have.
    const target = await tmpdir();
    const dir = await tmpdir();
    await fs.mkdir(path.join(target, "linked-skill"));
    await fs.writeFile(path.join(target, "linked-skill", "SKILL.md"), "x");

    try {
      await fs.symlink(path.join(target, "linked-skill"), path.join(dir, "linked-skill"), "junction");
    } catch {
      // Symlink creation can require elevated privileges on Windows. Failing
      // loudly beats a silent pass that proves nothing, so this fails the
      // test rather than returning early.
      expect.unreachable("could not create a symlink on this machine");
    }

    expect((await listSkills(dir)).map((s) => s.name)).toEqual(["linked-skill"]);
  });

  it("skips a dangling symlink rather than throwing", async () => {
    const dir = await tmpdir();
    try {
      await fs.symlink(path.join(dir, "nowhere"), path.join(dir, "broken"), "junction");
    } catch {
      return; // nothing to assert if the link could not be made
    }
    expect(await listSkills(dir)).toEqual([]);
  });

  it("returns nothing for a directory that does not exist", async () => {
    expect(await listSkills(path.join(os.tmpdir(), "minder-drift-absent-xyz"))).toEqual([]);
    expect(await listRules(path.join(os.tmpdir(), "minder-drift-absent-xyz"))).toEqual([]);
  });

  it("keys rules by basename so .md and .rules spellings match", async () => {
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, "context7.md"), "x");
    await fs.writeFile(path.join(dir, "default.rules"), "x");
    const rules = await listRules(dir);
    expect(rules.map((r) => r.key).sort()).toEqual(["context7", "default"]);
    expect(rules.every((r) => r.kind === "instruction")).toBe(true);
  });

  it("ignores dotfiles", async () => {
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, ".DS_Store"), "x");
    await fs.writeFile(path.join(dir, "real.md"), "x");
    expect((await listSkills(dir)).map((s) => s.name)).toEqual(["real"]);
  });
});

// ─── PR #359 review fixes ────────────────────────────────────────────────────

describe("a directory is only a skill when it carries SKILL.md", () => {
  const roots2: string[] = [];
  afterAll(async () => {
    await Promise.all(roots2.map((r) => fs.rm(r, { recursive: true, force: true })));
  });
  async function tmp(): Promise<string> {
    const dir = path.join(os.tmpdir(), `minder-drift2-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    roots2.push(dir);
    return dir;
  }

  it("skips a plain subdirectory with no SKILL.md", async () => {
    // The canonical walker requires the file; treating every directory as an
    // installed skill made scratch folders show up as "missing from Codex".
    const dir = await tmp();
    await fs.mkdir(path.join(dir, "not-a-skill"));
    await fs.mkdir(path.join(dir, "real"));
    await fs.writeFile(path.join(dir, "real", "SKILL.md"), "x");
    expect((await listSkills(dir)).map((s) => s.name)).toEqual(["real"]);
  });

  it("still accepts a standalone .md skill", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "standalone.md"), "x");
    expect((await listSkills(dir)).map((s) => s.name)).toEqual(["standalone"]);
  });
});

describe("directory listings are stable", () => {
  const roots3: string[] = [];
  afterAll(async () => {
    await Promise.all(roots3.map((r) => fs.rm(r, { recursive: true, force: true })));
  });

  it("sorts and filters dotfiles before applying the entry cap", async () => {
    // Capping raw readdir output let dotfiles consume slots real entries
    // needed, and left the surviving subset dependent on filesystem order —
    // so a large directory could make the report flap between runs.
    const dir = path.join(os.tmpdir(), `minder-drift3-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    roots3.push(dir);
    for (const n of [".hidden", "zeta.md", "alpha.md", ".DS_Store", "mid.md"]) {
      await fs.writeFile(path.join(dir, n), "x");
    }
    const names = (await listSkills(dir)).map((s) => s.name);
    expect(names).toEqual(["alpha", "mid", "zeta"]);
    expect(names).toEqual([...names].sort());
  });
});
