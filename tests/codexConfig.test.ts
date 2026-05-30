import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs.promises so readConfig is exercised against synthetic dir/file
// layouts without touching the real ~/.codex.
vi.mock("fs", () => ({
  promises: {
    stat: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    open: vi.fn(),
  },
}));

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import codexAdapter from "@/lib/adapters/codex";
import { REDACTED } from "@/lib/adapters/redact";

// `as any` — fs.promises' overloaded signatures otherwise collapse the mock
// implementation's param type to `never`. We drive these by path string.
const mockStat = vi.mocked(fs.stat) as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = vi.mocked(fs.readFile) as unknown as ReturnType<typeof vi.fn>;
const mockReaddir = vi.mocked(fs.readdir) as unknown as ReturnType<typeof vi.fn>;
const mockOpen = vi.mocked(fs.open) as unknown as ReturnType<typeof vi.fn>;

// Minimal FileHandle stub for the bounded rules read (open → read → close).
function fakeHandle(content: string) {
  const bytes = Buffer.from(content, "utf-8");
  return {
    read: async (buf: Buffer, offset: number, length: number) => {
      const n = Math.min(length, bytes.length);
      bytes.copy(buf, offset, 0, n);
      return { bytesRead: n };
    },
    close: async () => {},
  };
}

const HOME = "/home/tester";
const CODEX = path.join(HOME, ".codex");

const REAL_CONFIG = `model = "gpt-5.5"
model_reasoning_effort = "medium"
personality = "pragmatic"

[windows]
sandbox = "elevated"

[mcp_servers.Neon]
type = "http"
url = "https://mcp.neon.tech/mcp"

[mcp_servers.Neon.http_headers]
Authorization = "Bearer napi_supersecret0123456789abcdef"

[plugins."github@openai-curated"]
enabled = true
`;

function dirent(name: string) {
  return { name, isFile: () => true, isDirectory: () => false };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(os, "homedir").mockReturnValue(HOME);
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CODEX_HOME;
});

describe("codex readConfig — missing home", () => {
  it("returns present:false when ~/.codex does not exist", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const result = await codexAdapter.readConfig!();
    expect(result.present).toBe(false);
    expect(result.harnessId).toBe("codex");
    expect(result.home).toBe(CODEX);
    expect(result.config).toBeNull();
    expect(result.rules).toEqual([]);
  });
});

describe("codex readConfig — populated home", () => {
  beforeEach(() => {
    mockStat.mockImplementation((p: string) => {
      const s = String(p);
      // home + the "rules" and "plugins" resource dirs exist; others don't.
      if (s === CODEX || s.endsWith(`${path.sep}rules`) || s.endsWith(`${path.sep}plugins`)) {
        return Promise.resolve({ isDirectory: () => true });
      }
      return Promise.reject(new Error("ENOENT"));
    });
    mockReaddir.mockImplementation((p: string) => {
      if (String(p).endsWith(`${path.sep}rules`)) {
        return Promise.resolve([dirent("default.rules"), dirent("readme.txt"), dirent("ignored.json")]);
      }
      return Promise.reject(new Error("ENOENT"));
    });
    // config.toml is read whole (it must be parsed); rules go through the
    // bounded open→read path.
    mockReadFile.mockImplementation((p: string) =>
      String(p).endsWith("config.toml") ? Promise.resolve(REAL_CONFIG) : Promise.reject(new Error("ENOENT"))
    );
    mockOpen.mockImplementation((p: string) => {
      const s = String(p);
      if (s.endsWith("default.rules")) return Promise.resolve(fakeHandle("be concise"));
      if (s.endsWith("readme.txt")) return Promise.resolve(fakeHandle("notes"));
      return Promise.reject(new Error("ENOENT"));
    });
  });

  it("parses config.toml into a structured object", async () => {
    const r = await codexAdapter.readConfig!();
    expect(r.present).toBe(true);
    expect(r.parseError).toBeUndefined();
    const cfg = r.config as Record<string, any>;
    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.windows.sandbox).toBe("elevated");
    expect(cfg.plugins["github@openai-curated"].enabled).toBe(true);
  });

  it("redacts the Neon bearer token from http_headers", async () => {
    const r = await codexAdapter.readConfig!();
    const cfg = r.config as Record<string, any>;
    expect(cfg.mcp_servers.Neon.http_headers.Authorization).toBe(REDACTED);
    // innocent fields survive
    expect(cfg.mcp_servers.Neon.url).toBe("https://mcp.neon.tech/mcp");
    // the raw token must NOT appear anywhere in the serialized config
    expect(JSON.stringify(r.config)).not.toContain("napi_");
    expect(JSON.stringify(r.config)).not.toContain("supersecret");
  });

  it("reads rules files (.rules/.md/.txt), capping content, skipping others", async () => {
    const r = await codexAdapter.readConfig!();
    const names = r.rules.map((x) => x.name);
    expect(names).toContain("default.rules");
    expect(names).toContain("readme.txt");
    expect(names).not.toContain("ignored.json"); // not a rules extension
    const def = r.rules.find((x) => x.name === "default.rules")!;
    expect(def.content).toBe("be concise");
    expect(def.truncated).toBe(false);
  });

  it("caps an oversized rules file at read time and flags truncation", async () => {
    const big = "x".repeat(25_000); // > RULES_CONTENT_CAP (20_000)
    mockReaddir.mockImplementation((p: string) =>
      String(p).endsWith(`${path.sep}rules`)
        ? Promise.resolve([dirent("default.rules")])
        : Promise.reject(new Error("ENOENT"))
    );
    mockOpen.mockImplementation((p: string) =>
      String(p).endsWith("default.rules")
        ? Promise.resolve(fakeHandle(big))
        : Promise.reject(new Error("ENOENT"))
    );
    const r = await codexAdapter.readConfig!();
    const def = r.rules.find((x) => x.name === "default.rules")!;
    expect(def.truncated).toBe(true);
    expect(def.content.length).toBe(20_000);
  });

  it("reports resource presence without reading their contents", async () => {
    const r = await codexAdapter.readConfig!();
    const byName = Object.fromEntries(r.resources.map((x) => [x.name, x.present]));
    expect(byName.rules).toBe(true);
    expect(byName.plugins).toBe(true);
    expect(byName.memories).toBe(false);
    expect(byName.automations).toBe(false);
  });
});

describe("codex readConfig — bad TOML degrades", () => {
  it("returns parseError (not a throw) when config.toml is unparseable", async () => {
    mockStat.mockImplementation((p: string) =>
      String(p) === CODEX
        ? Promise.resolve({ isDirectory: () => true })
        : Promise.reject(new Error("ENOENT"))
    );
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    mockReadFile.mockImplementation((p: string) =>
      String(p).endsWith("config.toml")
        ? Promise.resolve("this = = not valid toml [[[")
        : Promise.reject(new Error("ENOENT"))
    );
    const r = await codexAdapter.readConfig!();
    expect(r.present).toBe(true);
    expect(r.config).toBeNull();
    expect(r.parseError).toMatch(/not valid toml/i);
  });

  it("does NOT echo a secret on the offending line into parseError", async () => {
    // A parser's error message typically quotes the broken line; the generic
    // parseError must not, or a secret near a syntax error would bypass the
    // object-level redaction.
    const secret = "napi_leak0123456789abcdef";
    const malformed = `Authorization = "Bearer ${secret}" = broken [[[`;
    mockStat.mockImplementation((p: string) =>
      String(p) === CODEX
        ? Promise.resolve({ isDirectory: () => true })
        : Promise.reject(new Error("ENOENT"))
    );
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    mockReadFile.mockImplementation((p: string) =>
      String(p).endsWith("config.toml") ? Promise.resolve(malformed) : Promise.reject(new Error("ENOENT"))
    );
    const r = await codexAdapter.readConfig!();
    expect(r.config).toBeNull();
    expect(r.parseError).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain("napi_");
  });
});

describe("codex readConfig — CODEX_HOME precedence", () => {
  it("resolves the home from $CODEX_HOME when set", async () => {
    process.env.CODEX_HOME = "/custom/codex";
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const r = await codexAdapter.readConfig!();
    expect(r.home).toBe(path.resolve("/custom/codex"));
  });
});
