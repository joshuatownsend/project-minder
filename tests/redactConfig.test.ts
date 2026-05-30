import { describe, it, expect } from "vitest";
import { redactConfig, REDACTED } from "@/lib/adapters/redact";

// Security-critical: a parsed harness config must never leak a secret. These
// exercise all three defenses against the actual shapes seen in a real Codex
// config.toml — secret tables, secret keys, and token-shaped values under
// innocent keys.

describe("redactConfig — secret tables", () => {
  it("blanks the whole http_headers table (the real Neon Bearer leak) but keeps keys", () => {
    const input = {
      mcp_servers: {
        Neon: {
          type: "http",
          url: "https://mcp.neon.tech/mcp",
          http_headers: { Authorization: "Bearer napi_abcdef0123456789abcdef" },
        },
      },
    };
    const out = redactConfig(input) as Record<string, any>;
    expect(out.mcp_servers.Neon.type).toBe("http");
    expect(out.mcp_servers.Neon.url).toBe("https://mcp.neon.tech/mcp"); // innocent value kept
    expect(out.mcp_servers.Neon.http_headers.Authorization).toBe(REDACTED);
  });

  it("blanks the entire env table, including non-secret-looking keys", () => {
    const out = redactConfig({ servers: { X: { env: { API_KEY: "sk-abcdefghijklmnop", PORT: "3000" } } } }) as any;
    expect(out.servers.X.env.API_KEY).toBe(REDACTED);
    expect(out.servers.X.env.PORT).toBe(REDACTED); // whole table is secret
  });

  it("blanks auth/credentials/headers tables", () => {
    const out = redactConfig({
      auth: { token: "x", user: "me" },
      credentials: { client_secret: "s" },
      headers: { "X-Api-Key": "k" },
    }) as any;
    expect(out.auth.token).toBe(REDACTED);
    expect(out.auth.user).toBe(REDACTED);
    expect(out.credentials.client_secret).toBe(REDACTED);
    expect(out.headers["X-Api-Key"]).toBe(REDACTED);
  });
});

describe("redactConfig — secret keys", () => {
  it("blanks scalars under obviously-secret keys, keeps the rest", () => {
    const out = redactConfig({
      token: "abc",
      apiKey: "xyz",
      api_key: "xyz",
      password: "p",
      private_key: "pk",
      model: "gpt-5.5",
      personality: "pragmatic",
    }) as any;
    expect(out.token).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.private_key).toBe(REDACTED);
    expect(out.model).toBe("gpt-5.5");
    expect(out.personality).toBe("pragmatic");
  });

  it("blanks an object value under a secret key", () => {
    const out = redactConfig({ secret: { nested: "deep", more: { x: 1 } } }) as any;
    expect(out.secret.nested).toBe(REDACTED);
    expect(out.secret.more.x).toBe(REDACTED);
  });
});

describe("redactConfig — value-shape backstop (secrets under innocent keys)", () => {
  it("redacts token-shaped values regardless of key name", () => {
    const out = redactConfig({
      a: "napi_0123456789abcdef",
      b: "sk-0123456789abcdef",
      c: "ghp_0123456789abcdefghij01234567890123",
      d: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart",
      e: "deadbeef".repeat(6), // 48 hex chars
      f: "https://example.com/Bearer something-with-token-1234",
      ok: "just a normal config string",
      model: "gpt-5.5",
    }) as any;
    expect(out.a).toBe(REDACTED);
    expect(out.b).toBe(REDACTED);
    expect(out.c).toBe(REDACTED);
    expect(out.d).toBe(REDACTED);
    expect(out.e).toBe(REDACTED);
    expect(out.f).toBe(REDACTED);
    expect(out.ok).toBe("just a normal config string");
    expect(out.model).toBe("gpt-5.5");
  });
});

describe("redactConfig — structure preservation & safety", () => {
  it("preserves nested objects, arrays, booleans, numbers, and quoted-dotted keys", () => {
    const out = redactConfig({
      model: "gpt-5.5",
      windows: { sandbox: "elevated" },
      plugins: { "github@openai-curated": { enabled: true } },
      nums: [1, 2, 3],
      nested: { deep: { ok: "value" } },
    }) as any;
    expect(out.windows.sandbox).toBe("elevated");
    expect(out.plugins["github@openai-curated"].enabled).toBe(true);
    expect(out.nums).toEqual([1, 2, 3]);
    expect(out.nested.deep.ok).toBe("value");
  });

  it("redacts secrets inside arrays of tables", () => {
    const out = redactConfig({ servers: [{ env: { KEY: "secret" } }, { url: "ok" }] }) as any;
    expect(out.servers[0].env.KEY).toBe(REDACTED);
    expect(out.servers[1].url).toBe("ok");
  });

  it("does not mutate the input object", () => {
    const input = { http_headers: { Authorization: "Bearer secret-value-here" }, model: "gpt-5.5" };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactConfig(input);
    expect(input).toEqual(snapshot);
  });

  it("passes scalars and null through unchanged", () => {
    expect(redactConfig("hello")).toBe("hello");
    expect(redactConfig(42)).toBe(42);
    expect(redactConfig(true)).toBe(true);
    expect(redactConfig(null)).toBeNull();
  });
});
