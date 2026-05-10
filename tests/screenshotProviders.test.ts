import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callProvider, ProviderError } from "@/mcp/screenshot-to-code/providers";

// Each provider is a single fetch call with vendor-specific request/
// response shapes. Mocking global.fetch lets us pin the wire format
// (headers, URL, body) AND the parsing of the success/failure paths
// without an SDK pulling in actual network behavior.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleInput = {
  base64: "AAA=",
  mediaType: "image/png" as const,
  prompt: "convert this",
  model: "test-model",
  apiKey: "test-key",
};

describe("Gemini provider", () => {
  it("posts to generateContent with key in query string and inlineData body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const out = await callProvider("gemini", sampleInput);
    expect(out).toBe("ok");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/models/test-model:generateContent");
    expect(String(url)).toContain("key=test-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.contents[0].parts[0].text).toBe("convert this");
    expect(body.contents[0].parts[1].inlineData).toEqual({
      mimeType: "image/png",
      data: "AAA=",
    });
  });

  it("concatenates multiple parts in the response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await callProvider("gemini", sampleInput)).toBe("hello world");
  });

  it("throws ProviderError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(callProvider("gemini", sampleInput)).rejects.toThrow(ProviderError);
  });

  it("throws on empty response body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    );
    await expect(callProvider("gemini", sampleInput)).rejects.toMatchObject({
      provider: "gemini",
    });
  });
});

describe("OpenAI provider", () => {
  it("posts to /v1/chat/completions with Bearer auth and image_url data URL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      ),
    );

    const out = await callProvider("openai", sampleInput);
    expect(out).toBe("ok");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages[0].content[1].image_url.url).toBe("data:image/png;base64,AAA=");
  });

  it("throws ProviderError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("rate limit", { status: 429, statusText: "Too Many" }),
    );
    await expect(callProvider("openai", sampleInput)).rejects.toMatchObject({
      provider: "openai",
      status: 429,
    });
  });
});

describe("Anthropic provider", () => {
  it("posts to /v1/messages with x-api-key + anthropic-version headers and image source block", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        { status: 200 },
      ),
    );

    const out = await callProvider("anthropic", sampleInput);
    expect(out).toBe("ok");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect((init as RequestInit).headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAA=" },
    });
  });

  it("filters non-text content blocks before joining", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "hello " },
            { type: "tool_use", text: "ignored" },
            { type: "text", text: "world" },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await callProvider("anthropic", sampleInput)).toBe("hello world");
  });

  it("throws ProviderError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    await expect(callProvider("anthropic", sampleInput)).rejects.toMatchObject({
      provider: "anthropic",
      status: 403,
    });
  });
});
