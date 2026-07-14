import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@/lib/types";

// Mock the probe so the cache logic is tested in isolation (no fetch / fs).
vi.mock("@/lib/mcpHealth", () => ({
  probeMcpServer: vi.fn(async (s: McpServer) => ({
    name: s.name,
    transport: s.transport,
    source: s.source,
    status: "up" as const,
    // Echo the probe target so a redefinition is observable in the verdict.
    detail: s.command ?? s.url ?? "",
    probeKind: "none" as const,
  })),
}));

import { probeMcpServer } from "@/lib/mcpHealth";
import { mcpHealthCache, serverIdentity } from "@/lib/mcpHealthCache";

const probe = vi.mocked(probeMcpServer);

function server(overrides: Partial<McpServer>): McpServer {
  return {
    name: "srv",
    transport: "stdio",
    source: "user",
    sourcePath: "/x/.claude.json",
    ...overrides,
  };
}

/** Cache lookups are keyed by identity — resolve it from the server def. */
const id = (s: McpServer) => serverIdentity(s);

beforeEach(() => {
  mcpHealthCache.setStdioHandshake(false); // reset opt-in mode between tests
  mcpHealthCache.dispose(); // fresh singleton state per test
  probe.mockClear();
});

describe("mcpHealthCache", () => {
  it("probes enqueued servers and getAll returns unwrapped health keyed by identity", async () => {
    const s = server({ name: "a", command: "node" });
    mcpHealthCache.enqueue([s]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s))).not.toBeNull());

    const all = mcpHealthCache.getAll();
    expect(all[id(s)]).toMatchObject({ name: "a", status: "up", detail: "node" });
    expect(all[id(s)].checkedAt).toBeTypeOf("number"); // unwrapped McpHealth, not { health, sig }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not re-probe a fresh, unchanged server", async () => {
    const s = server({ name: "a", command: "node" });
    mcpHealthCache.enqueue([s]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s))).not.toBeNull());
    probe.mockClear();

    mcpHealthCache.enqueue([s]); // same identity, same signature, still fresh
    // give any (incorrect) queued probe a chance to fire
    await new Promise((r) => setTimeout(r, 20));
    expect(probe).not.toHaveBeenCalled();
  });

  it("re-probes when the definition changes under the same identity", async () => {
    const s1 = server({ name: "a", command: "node" });
    mcpHealthCache.enqueue([s1]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s1))?.detail).toBe("node"));
    probe.mockClear();

    // Same identity (source/sourcePath/name), repointed command → different
    // signature → must re-probe.
    const s2 = server({ name: "a", command: "deno" });
    mcpHealthCache.enqueue([s2]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s2))?.detail).toBe("deno"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes when transport changes (stdio → http)", async () => {
    const s1 = server({ name: "a", command: "node" });
    mcpHealthCache.enqueue([s1]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s1))?.detail).toBe("node"));
    probe.mockClear();

    const s2 = server({ name: "a", transport: "http", command: undefined, url: "https://x" });
    mcpHealthCache.enqueue([s2]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s2))?.detail).toBe("https://x"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes when an env key is added/removed (handshake verdict depends on it)", async () => {
    const s1 = server({ name: "a", command: "node", envKeys: ["A"] });
    mcpHealthCache.enqueue([s1]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s1))).not.toBeNull());
    probe.mockClear();

    // Same identity + command/args, but an env key added → different signature.
    const s2 = server({ name: "a", command: "node", envKeys: ["A", "B"] });
    mcpHealthCache.enqueue([s2]);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  });

  it("toggling the stdio handshake flag disposes cached verdicts so they re-probe", async () => {
    const s = server({ name: "a", command: "node" });
    mcpHealthCache.enqueue([s]);
    await vi.waitFor(() => expect(mcpHealthCache.get(id(s))).not.toBeNull());
    probe.mockClear();

    mcpHealthCache.setStdioHandshake(true); // flag flip → dispose
    expect(mcpHealthCache.get(id(s))).toBeNull(); // verdicts cleared

    mcpHealthCache.enqueue([s]); // re-probe under the new mode
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  });

  it("keeps two same-name servers from different sources as distinct entries", async () => {
    // getUserConfig preserves both; a name-only key would collapse them.
    const userDup = server({ name: "dup", source: "user", sourcePath: "/u/.claude.json", command: "u-cmd" });
    const pluginDup = server({ name: "dup", source: "plugin", sourcePath: "/p/.mcp.json", command: "p-cmd" });
    mcpHealthCache.enqueue([userDup, pluginDup]);

    await vi.waitFor(() => expect(Object.keys(mcpHealthCache.getAll())).toHaveLength(2));
    const all = mcpHealthCache.getAll();
    expect(all[id(userDup)]?.detail).toBe("u-cmd");
    expect(all[id(pluginDup)]?.detail).toBe("p-cmd");
    expect(id(userDup)).not.toBe(id(pluginDup));
  });
});
