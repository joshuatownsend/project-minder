import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@/lib/types";

// Mock the probe so the cache logic is tested in isolation (no fetch / fs).
vi.mock("@/lib/mcpHealth", () => ({
  probeMcpServer: vi.fn(async (s: McpServer) => ({
    name: s.name,
    transport: s.transport,
    status: "up" as const,
    // Echo the probe target so a redefinition is observable in the verdict.
    detail: s.command ?? s.url ?? "",
    probeKind: "none" as const,
  })),
}));

import { probeMcpServer } from "@/lib/mcpHealth";
import { mcpHealthCache } from "@/lib/mcpHealthCache";

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

beforeEach(() => {
  mcpHealthCache.dispose(); // fresh singleton state per test
  probe.mockClear();
});

describe("mcpHealthCache", () => {
  it("probes enqueued servers and getAll returns unwrapped health", async () => {
    mcpHealthCache.enqueue([server({ name: "a", command: "node" })]);
    await vi.waitFor(() => expect(mcpHealthCache.get("a")).not.toBeNull());

    const all = mcpHealthCache.getAll();
    expect(all.a).toMatchObject({ name: "a", status: "up", detail: "node" });
    expect(all.a.checkedAt).toBeTypeOf("number"); // unwrapped McpHealth, not { health, sig }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not re-probe a fresh, unchanged server", async () => {
    const s = server({ name: "a", command: "node" });
    mcpHealthCache.enqueue([s]);
    await vi.waitFor(() => expect(mcpHealthCache.get("a")).not.toBeNull());
    probe.mockClear();

    mcpHealthCache.enqueue([s]); // same name, same signature, still fresh
    // give any (incorrect) queued probe a chance to fire
    await new Promise((r) => setTimeout(r, 20));
    expect(probe).not.toHaveBeenCalled();
  });

  it("re-probes when the definition changes under the same name", async () => {
    mcpHealthCache.enqueue([server({ name: "a", command: "node" })]);
    await vi.waitFor(() => expect(mcpHealthCache.get("a")?.detail).toBe("node"));
    probe.mockClear();

    // Same name, repointed command → different signature → must re-probe.
    mcpHealthCache.enqueue([server({ name: "a", command: "deno" })]);
    await vi.waitFor(() => expect(mcpHealthCache.get("a")?.detail).toBe("deno"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes when transport changes (stdio → http)", async () => {
    mcpHealthCache.enqueue([server({ name: "a", command: "node" })]);
    await vi.waitFor(() => expect(mcpHealthCache.get("a")?.detail).toBe("node"));
    probe.mockClear();

    mcpHealthCache.enqueue([
      server({ name: "a", transport: "http", command: undefined, url: "https://x" }),
    ]);
    await vi.waitFor(() => expect(mcpHealthCache.get("a")?.detail).toBe("https://x"));
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
