import { describe, it, expect } from "vitest";
import {
  agentKey,
  skillKey,
  commandKey,
  hookKey,
  makeHookKey,
  mcpKey,
  explodeHookCommands,
  findHookByKey,
  findMcpByKey,
} from "@/lib/template/unitKey";
import type { HookEntry, McpServer } from "@/lib/types";

describe("unitKey — simple key builders", () => {
  it("agentKey returns the slug", () => {
    expect(agentKey("frontend-developer")).toBe("frontend-developer");
  });

  it("skillKey appends layout discriminator", () => {
    expect(skillKey("db-migrate", "bundled")).toBe("db-migrate:bundled");
    expect(skillKey("review", "standalone")).toBe("review:standalone");
  });

  it("commandKey returns the slug", () => {
    expect(commandKey("generate-tests")).toBe("generate-tests");
  });

  it("mcpKey returns the server name", () => {
    expect(mcpKey({ name: "context7" })).toBe("context7");
  });
});

describe("unitKey — hook keys", () => {
  it("makeHookKey produces deterministic 16-hex suffix", () => {
    const k1 = makeHookKey("PostToolUse", "Edit", "echo hi");
    const k2 = makeHookKey("PostToolUse", "Edit", "echo hi");
    expect(k1).toBe(k2);
    expect(k1.split("|")[2]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("makeHookKey distinguishes by invocation content", () => {
    const a = makeHookKey("PostToolUse", "Edit", "echo a");
    const b = makeHookKey("PostToolUse", "Edit", "echo b");
    expect(a).not.toBe(b);
  });

  it("makeHookKey treats missing matcher as '*'", () => {
    expect(makeHookKey("Stop", undefined, "echo hi").startsWith("Stop|*|")).toBe(true);
    expect(makeHookKey("Stop", "*", "echo hi")).toBe(makeHookKey("Stop", undefined, "echo hi"));
  });

  it("hookKey on a single-invocation entry matches makeHookKey", () => {
    const entry: HookEntry = {
      event: "PostToolUse",
      matcher: "Edit",
      commands: [{ type: "command", command: "echo hi" }],
      source: "project",
      sourcePath: "/x/.claude/settings.json",
    };
    expect(hookKey(entry)).toBe(makeHookKey("PostToolUse", "Edit", "echo hi"));
  });
});

describe("unitKey — explode + find", () => {
  it("explodeHookCommands splits multi-invocation entries into singletons", () => {
    const entry: HookEntry = {
      event: "PostToolUse",
      matcher: "Edit",
      commands: [
        { type: "command", command: "echo a" },
        { type: "command", command: "echo b" },
      ],
      source: "project",
      sourcePath: "/x/.claude/settings.json",
    };
    const exploded = explodeHookCommands(entry);
    expect(exploded).toHaveLength(2);
    expect(exploded[0].commands).toEqual([{ type: "command", command: "echo a" }]);
    expect(exploded[1].commands).toEqual([{ type: "command", command: "echo b" }]);
    // Each singleton has a distinct key.
    expect(hookKey(exploded[0])).not.toBe(hookKey(exploded[1]));
  });

  it("explodeHookCommands passes single-invocation entries through unchanged", () => {
    const entry: HookEntry = {
      event: "Stop",
      commands: [{ type: "command", command: "echo solo" }],
      source: "user",
      sourcePath: "/x/.claude/settings.json",
    };
    const exploded = explodeHookCommands(entry);
    expect(exploded).toHaveLength(1);
    expect(exploded[0]).toBe(entry);
  });

  it("findHookByKey finds a single-invocation entry hidden inside a multi-invocation entry", () => {
    const entry: HookEntry = {
      event: "PostToolUse",
      matcher: "Edit",
      commands: [
        { type: "command", command: "echo a" },
        { type: "command", command: "echo b" },
      ],
      source: "project",
      sourcePath: "/x/.claude/settings.json",
    };
    const target = makeHookKey("PostToolUse", "Edit", "echo b");
    const found = findHookByKey([entry], target);
    expect(found).toBeDefined();
    expect(found!.commands).toEqual([{ type: "command", command: "echo b" }]);
  });

  it("findHookByKey returns undefined for an unknown key", () => {
    const entry: HookEntry = {
      event: "PostToolUse",
      commands: [{ type: "command", command: "echo a" }],
      source: "project",
      sourcePath: "/x",
    };
    expect(findHookByKey([entry], "nope|*|deadbeef")).toBeUndefined();
  });

  it("findMcpByKey finds by server name", () => {
    const server: McpServer = {
      name: "ctx",
      transport: "stdio",
      command: "node",
      source: "project",
      sourcePath: "/x/.mcp.json",
    };
    expect(findMcpByKey([server], "ctx")).toBe(server);
    expect(findMcpByKey([server], "other")).toBeUndefined();
  });
});
