import { describe, it, expect } from "vitest";
import { diffEnvironments, homeForLocation, type EnvironmentInventory } from "@/lib/environments/diff";

function home(key: string, over: Partial<EnvironmentInventory> = {}): EnvironmentInventory {
  return {
    key,
    path: key,
    primary: false,
    agents: [],
    skills: [],
    plugins: [],
    mcpServers: [],
    ...over,
  };
}

const WIN = home("c:/users/me/.claude", {
  primary: true,
  agents: [
    { slug: "reviewer", name: "Reviewer", description: "Reviews diffs", source: "user" },
    { slug: "planner", source: "user" },
  ],
  skills: [
    { slug: "pr-resolve", disabled: false, source: "user" },
    { slug: "deploy", disabled: false, source: "user" },
  ],
  plugins: [{ id: "github@official", name: "github", marketplace: "official", version: "1.2.0" }],
  mcpServers: ["project-minder", "context7"],
});

const WSL = home("//wsl.localhost/ubuntu/home/me/.claude", {
  agents: [{ slug: "reviewer", name: "Reviewer", source: "user" }],
  skills: [
    { slug: "pr-resolve", disabled: true, source: "user" },
    { slug: "deploy", disabled: false, source: "user" },
  ],
  plugins: [{ id: "github@official", name: "github", marketplace: "official", version: "1.1.0" }],
  mcpServers: ["context7"],
});

describe("diffEnvironments", () => {
  it("flags entries missing from a home and details that differ", () => {
    const d = diffEnvironments([WIN, WSL]);
    expect(d.homeKeys).toEqual([WIN.key, WSL.key]);
    const rows = Object.fromEntries(d.kinds.map((k) => [k.kind, k.rows]));

    expect(rows.agent.find((r) => r.id === "user:planner")).toMatchObject({
      presentIn: [WIN.key],
      uniform: false,
      label: "planner",
    });
    expect(rows.agent.find((r) => r.id === "user:reviewer")).toMatchObject({ uniform: true, label: "Reviewer" });

    const pr = rows.skill.find((r) => r.id === "user:pr-resolve")!;
    expect(pr.uniform).toBe(false);
    expect(pr.detailIn).toEqual({ [WSL.key]: "disabled" });
    expect(rows.skill.find((r) => r.id === "user:deploy")!.uniform).toBe(true);

    const gh = rows.plugin[0];
    expect(gh.uniform).toBe(false);
    expect(gh.detailIn).toEqual({ [WIN.key]: "1.2.0", [WSL.key]: "1.1.0" });

    expect(rows.mcp.find((r) => r.id === "project-minder")!.presentIn).toEqual([WIN.key]);
    expect(d.divergent).toBe(4);
  });

  it("sorts divergent rows first, then by id", () => {
    const d = diffEnvironments([WIN, WSL]);
    const skills = d.kinds.find((k) => k.kind === "skill")!;
    expect(skills.rows.map((r) => r.id)).toEqual(["user:pr-resolve", "user:deploy"]);
    expect(skills.divergent).toBe(1);
  });

  it("keeps a user entry and a plugin entry of the same slug as different rows", () => {
    // A home with `reviewer` from a plugin and a home with its own `reviewer`
    // do not agree: the provider is part of the identity.
    const a = home("a", { agents: [{ slug: "reviewer", source: "user" }] });
    const b = home("b", { agents: [{ slug: "reviewer", source: "plugin", pluginName: "review-kit" }] });
    const rows = diffEnvironments([a, b]).kinds.find((k) => k.kind === "agent")!.rows;
    expect(rows.map((r) => r.id).sort()).toEqual(["plugin:review-kit:reviewer", "user:reviewer"]);
    expect(rows.every((r) => !r.uniform)).toBe(true);
    expect(rows.find((r) => r.id.startsWith("plugin:"))!.pluginName).toBe("review-kit");
    expect(rows.find((r) => r.id.startsWith("user:"))!.pluginName).toBeUndefined();
  });

  it("tells the same plugin name from two marketplaces apart by registry key", () => {
    // `review-kit@official` and `review-kit@community` both ship `reviewer`;
    // the registry treats them as different plugins and so must the diff.
    const a = home("a", { agents: [{ slug: "reviewer", source: "plugin", pluginName: "review-kit", pluginId: "review-kit@official" }] });
    const b = home("b", { agents: [{ slug: "reviewer", source: "plugin", pluginName: "review-kit", pluginId: "review-kit@community" }] });
    const rows = diffEnvironments([a, b]).kinds.find((k) => k.kind === "agent")!.rows;
    expect(rows.map((r) => r.id).sort()).toEqual(["plugin:review-kit@community:reviewer", "plugin:review-kit@official:reviewer"]);
    expect(rows.every((r) => !r.uniform)).toBe(true);
    // The label stays the plugin NAME; the key is identity, not display.
    expect(rows.every((r) => r.pluginName === "review-kit")).toBe(true);
  });

  it("keys rows on the catalog id when present, so two same-slug files stay two rows", () => {
    // A standalone `foo.md` beside a bundled `foo/SKILL.md` in one home; the
    // other home has only the bundled one. Slug alone would fold the pair.
    const a = home("a", {
      skills: [
        { slug: "foo", source: "user", disabled: false, identity: "skill:user:user:foo" },
        { slug: "foo", source: "user", disabled: false, identity: "skill:user:user:bundled:foo" },
      ],
    });
    const b = home("b", { skills: [{ slug: "foo", source: "user", disabled: false, identity: "skill:user:user:bundled:foo" }] });
    const rows = diffEnvironments([a, b]).kinds.find((k) => k.kind === "skill")!.rows;
    expect(rows.map((r) => [r.id, r.uniform]).sort()).toEqual([
      ["user:skill:user:user:bundled:foo", true],
      ["user:skill:user:user:foo", false],
    ]);
  });

  it("carries the first description any home declares onto the row", () => {
    const d = diffEnvironments([WSL, WIN]); // WSL first: its reviewer has no description
    const reviewer = d.kinds.find((k) => k.kind === "agent")!.rows.find((r) => r.id === "user:reviewer")!;
    expect(reviewer.description).toBe("Reviews diffs");
  });

  it("marks an unreadable plugin in its detail so the column says why it is thin", () => {
    const a = home("a", { plugins: [{ id: "x@m", name: "x", marketplace: "m", version: "2", unresolved: true }] });
    const b = home("b", { plugins: [{ id: "x@m", name: "x", marketplace: "m", version: "2" }] });
    const row = diffEnvironments([a, b]).kinds.find((k) => k.kind === "plugin")!.rows[0];
    expect(row.detailIn).toEqual({ a: "2 · unreadable", b: "2" });
    expect(row.uniform).toBe(false);
  });

  it("treats a single home as uniform everywhere", () => {
    const d = diffEnvironments([WIN]);
    expect(d.divergent).toBe(0);
    expect(d.kinds.every((k) => k.rows.every((r) => r.uniform))).toBe(true);
  });

  it("a detail that agrees in every home is still uniform", () => {
    const a = home("a", { plugins: [{ id: "x@m", name: "x", marketplace: "m", version: "2" }] });
    const b = home("b", { plugins: [{ id: "x@m", name: "x", marketplace: "m", version: "2" }] });
    expect(diffEnvironments([a, b]).divergent).toBe(0);
  });

  it("is empty for no homes", () => {
    const d = diffEnvironments([]);
    expect(d.kinds.every((k) => k.rows.length === 0)).toBe(true);
    expect(d.divergent).toBe(0);
  });
});

describe("homeForLocation", () => {
  it("maps an unpinned location to the primary home and a pinned one by key", () => {
    expect(homeForLocation(undefined, [WSL, WIN])).toBe(WIN);
    expect(homeForLocation(WSL.key, [WIN, WSL])).toBe(WSL);
  });

  it("is undefined when the pinned home was not read", () => {
    expect(homeForLocation(WSL.key, [WIN])).toBeUndefined();
  });
});
