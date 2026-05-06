import { describe, it, expect } from "vitest";
import {
  computeEffectiveAgents,
  computeEffectiveSkills,
  computeEffectiveMcp,
  computeEffectiveHooks,
} from "@/lib/effectiveConfig";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";
import type { McpServer, HookEntry } from "@/lib/types";

// Minimal stubs — only fields used by effectiveConfig
function agent(id: string, name: string, source: "user" | "project" | "plugin"): AgentEntry {
  return { id, name, source, kind: "agent" } as AgentEntry;
}

function skill(id: string, name: string, source: "user" | "project" | "plugin", disabled = false): SkillEntry {
  return { id, name, source, kind: "skill", disabled } as SkillEntry;
}

function mcpServer(name: string, source: "project" | "user" | "managed" | "local" | "plugin" | "desktop", disabled = false): McpServer {
  return { name, source, transport: "stdio", sourcePath: "/x", disabled };
}

function hookEntry(event: string, command: string, source: "project" | "user" | "local"): HookEntry {
  return { event, matcher: undefined, commands: [{ type: "command", command }], source, sourcePath: "/x" };
}

// ─── Agents ──────────────────────────────────────────────────────────────────

describe("computeEffectiveAgents", () => {
  it("single agent per name → all active", () => {
    const states = computeEffectiveAgents([
      agent("a1", "foo", "user"),
      agent("a2", "bar", "project"),
    ]);
    expect(states.get("a1")).toBe("active");
    expect(states.get("a2")).toBe("active");
  });

  it("user shadows project when same name", () => {
    const states = computeEffectiveAgents([
      agent("u1", "deploy", "user"),
      agent("p1", "deploy", "project"),
    ]);
    expect(states.get("u1")).toBe("active");
    expect(states.get("p1")).toBe("shadowed");
  });

  it("project shadows plugin when same name", () => {
    const states = computeEffectiveAgents([
      agent("p1", "review", "project"),
      agent("pl1", "review", "plugin"),
    ]);
    expect(states.get("p1")).toBe("active");
    expect(states.get("pl1")).toBe("shadowed");
  });
});

// ─── Skills ──────────────────────────────────────────────────────────────────

describe("computeEffectiveSkills", () => {
  it("all distinct names → all active", () => {
    const states = computeEffectiveSkills([
      skill("s1", "foo", "user"),
      skill("s2", "bar", "project"),
    ]);
    expect(states.get("s1")).toBe("active");
    expect(states.get("s2")).toBe("active");
  });

  it("user shadows project", () => {
    const states = computeEffectiveSkills([
      skill("u1", "commit", "user"),
      skill("p1", "commit", "project"),
    ]);
    expect(states.get("u1")).toBe("active");
    expect(states.get("p1")).toBe("shadowed");
  });

  it("disabled flag overrides active state", () => {
    const states = computeEffectiveSkills([
      skill("u1", "commit", "user", true),
    ]);
    expect(states.get("u1")).toBe("disabled");
  });

  it("disabled flag overrides shadowed state too", () => {
    const states = computeEffectiveSkills([
      skill("u1", "commit", "user", true),
      skill("p1", "commit", "project"),
    ]);
    expect(states.get("u1")).toBe("disabled");
    expect(states.get("p1")).toBe("shadowed");
  });
});

// ─── MCP servers ─────────────────────────────────────────────────────────────

describe("computeEffectiveMcp", () => {
  it("all distinct names, no managed → all active", () => {
    const states = computeEffectiveMcp([
      mcpServer("github", "project"),
      mcpServer("memory", "user"),
    ]);
    expect(states.get("github")).toBe("active");
    expect(states.get("memory")).toBe("active");
  });

  it("disabled server → disabled state", () => {
    const states = computeEffectiveMcp([
      mcpServer("flaky", "project", true),
    ]);
    expect(states.get("flaky")).toBe("disabled");
  });

  it("managed scope → non-managed servers shadowed", () => {
    const states = computeEffectiveMcp([
      mcpServer("approved", "managed"),
      mcpServer("user-server", "user"),
      mcpServer("project-server", "project"),
    ]);
    expect(states.get("approved")).toBe("active");
    expect(states.get("user-server")).toBe("shadowed");
    expect(states.get("project-server")).toBe("shadowed");
  });

  it("duplicate name across scopes → conflict", () => {
    const states = computeEffectiveMcp([
      mcpServer("github", "project"),
      mcpServer("github", "user"),
    ]);
    expect(states.get("github")).toBe("conflict");
  });
});

// ─── Hooks ───────────────────────────────────────────────────────────────────

describe("computeEffectiveHooks", () => {
  it("distinct hooks → all active", () => {
    const states = computeEffectiveHooks([
      hookEntry("PreToolUse", "node check.js", "project"),
      hookEntry("Stop", "bash stop.sh", "user"),
    ]);
    // Keys are makeHookKey results — just verify both are "active" (not conflict)
    expect([...states.values()].every((v) => v === "active")).toBe(true);
  });

  it("same hook in two scopes → conflict", () => {
    const hooks = [
      hookEntry("PreToolUse", "node check.js", "project"),
      hookEntry("PreToolUse", "node check.js", "user"),
    ];
    const states = computeEffectiveHooks(hooks);
    // All entries should be "conflict" since the key matches
    expect([...states.values()].every((v) => v === "conflict")).toBe(true);
  });
});
