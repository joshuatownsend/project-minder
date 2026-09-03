import { describe, it, expect } from "vitest";
import { diffEnvironments, homeForLocation, type EnvironmentHome } from "@/lib/environments/diff";

function home(key: string, over: Partial<EnvironmentHome> = {}): EnvironmentHome {
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
  agents: [{ slug: "reviewer", name: "Reviewer" }, { slug: "planner" }],
  skills: [
    { slug: "pr-resolve", disabled: false },
    { slug: "deploy", disabled: false },
  ],
  plugins: [{ id: "github@official", name: "github", marketplace: "official", version: "1.2.0" }],
  mcpServers: ["project-minder", "context7"],
});

const WSL = home("//wsl.localhost/ubuntu/home/me/.claude", {
  agents: [{ slug: "reviewer", name: "Reviewer" }],
  skills: [
    { slug: "pr-resolve", disabled: true },
    { slug: "deploy", disabled: false },
  ],
  plugins: [{ id: "github@official", name: "github", marketplace: "official", version: "1.1.0" }],
  mcpServers: ["context7"],
});

describe("diffEnvironments", () => {
  it("flags entries missing from a home and details that differ", () => {
    const d = diffEnvironments([WIN, WSL]);
    expect(d.homeKeys).toEqual([WIN.key, WSL.key]);
    const rows = Object.fromEntries(d.kinds.map((k) => [k.kind, k.rows]));

    expect(rows.agent.find((r) => r.id === "planner")).toMatchObject({
      presentIn: [WIN.key],
      uniform: false,
      label: "planner",
    });
    expect(rows.agent.find((r) => r.id === "reviewer")).toMatchObject({ uniform: true, label: "Reviewer" });

    const pr = rows.skill.find((r) => r.id === "pr-resolve")!;
    expect(pr.uniform).toBe(false);
    expect(pr.detailIn).toEqual({ [WSL.key]: "disabled" });
    expect(rows.skill.find((r) => r.id === "deploy")!.uniform).toBe(true);

    const gh = rows.plugin[0];
    expect(gh.uniform).toBe(false);
    expect(gh.detailIn).toEqual({ [WIN.key]: "1.2.0", [WSL.key]: "1.1.0" });

    expect(rows.mcp.find((r) => r.id === "project-minder")!.presentIn).toEqual([WIN.key]);
    expect(d.divergent).toBe(4);
  });

  it("sorts divergent rows first, then by id", () => {
    const d = diffEnvironments([WIN, WSL]);
    const skills = d.kinds.find((k) => k.kind === "skill")!;
    expect(skills.rows.map((r) => r.id)).toEqual(["pr-resolve", "deploy"]);
    expect(skills.divergent).toBe(1);
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
