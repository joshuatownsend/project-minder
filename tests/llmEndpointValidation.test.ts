import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #630 — the stored LLM API key is attached to whatever endpoint a call uses, so a request-supplied
// URL must be held to the same rule as the saved setting, and never receive the key otherwise.

vi.mock("@/lib/llm/secretsStore", () => ({ getSecret: vi.fn(async () => "sk-stored-secret") }));
vi.mock("@/lib/config", () => ({ readConfig: vi.fn(async () => ({})) }));

import { isValidLlmEndpoint, isAnthropicHost } from "@/lib/llm/endpoint";
import { generateTitle } from "@/lib/llm/autoTitle";
import { distillSession } from "@/lib/llm/distill";
import { POST } from "@/app/api/llm/test/route";

describe("isValidLlmEndpoint", () => {
  it.each([
    "https://api.anthropic.com/v1/messages",
    "https://example.com/v1/chat/completions",
    "http://localhost:11434/v1/chat/completions",
    "http://127.0.0.1:8080/x",
    "http://[::1]:8080/x",
  ])("accepts %s", (u) => expect(isValidLlmEndpoint(u)).toBe(true));

  it.each([
    "http://evil.test/x",
    "http://localhost.evil.test/x",
    "ftp://example.com",
    "https://user:pw@example.com/x",
    "not a url",
    "",
    undefined,
    42,
  ])("rejects %s", (u) => expect(isValidLlmEndpoint(u)).toBe(false));
});

describe("isAnthropicHost", () => {
  it("matches the parsed hostname, not a substring of the URL", () => {
    expect(isAnthropicHost("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(isAnthropicHost("https://evil.example/anthropic.com")).toBe(false);
    expect(isAnthropicHost("https://anthropic.com.evil.example/x")).toBe(false);
    expect(isAnthropicHost("https://api.anthropic.com./v1/messages")).toBe(true); // trailing root dot, same host
  });
});

describe("the stored key never reaches an unacceptable endpoint", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("generateTitle refuses a plain-http remote endpoint without fetching", async () => {
    await expect(generateTitle({ endpoint: "http://evil.test/", turns: [] })).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("distillSession refuses it too", async () => {
    await expect(distillSession({ endpoint: "http://evil.test/", turns: [] })).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POST /api/llm/test takes no request input and only ever contacts the saved endpoint (the default here)", async () => {
    const res = await POST();
    expect(res.status).toBeLessThan(600);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.anthropic.com/v1/messages"]);
  });

  it("an acceptable endpoint still gets the request (key as x-api-key only for Anthropic hosts)", async () => {
    await generateTitle({ endpoint: "https://evil.example/anthropic.com", turns: [] }).catch(() => {});
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer sk-stored-secret");
    expect(init.redirect).toBe("error");
  });
});
