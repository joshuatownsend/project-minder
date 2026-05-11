import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `handleCall` is the request-handling core of the MCP server; pulling it
// out of `index.ts` lets us exercise the full validate → call → clean
// path without spawning the stdio transport. We mock the providers
// module so the test never touches the network.

vi.mock("@/mcp/screenshot-to-code/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/screenshot-to-code/providers")>();
  return {
    ...actual,
    callProvider: vi.fn(),
  };
});

import { handleCall, type ServerConfig } from "@/mcp/screenshot-to-code/index";
import * as providers from "@/mcp/screenshot-to-code/providers";

const mockedCallProvider = vi.mocked(providers.callProvider);

const config: ServerConfig = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  apiKeyEnvVar: "TEST_API_KEY",
};

beforeEach(() => {
  mockedCallProvider.mockReset();
  delete process.env.TEST_API_KEY;
});

afterEach(() => {
  delete process.env.TEST_API_KEY;
});

describe("handleCall", () => {
  it("returns isError when image is missing", async () => {
    process.env.TEST_API_KEY = "k";
    const r = await handleCall({}, config);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/image/);
  });

  it("returns isError when args are not an object", async () => {
    process.env.TEST_API_KEY = "k";
    const r = await handleCall("not-an-object", config);
    expect(r.isError).toBe(true);
  });

  it("returns isError with env-var hint when API key missing", async () => {
    const r = await handleCall({ image: "AAA=" }, config);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/TEST_API_KEY/);
    expect(mockedCallProvider).not.toHaveBeenCalled();
  });

  it("calls the provider with resolved defaults and returns cleaned code", async () => {
    process.env.TEST_API_KEY = "k";
    mockedCallProvider.mockResolvedValueOnce("```tsx\nconst x = 1;\nexport default x;\n```");

    const r = await handleCall({ image: "AAA=" }, config);

    expect(r.isError).toBeUndefined();
    expect(mockedCallProvider).toHaveBeenCalledTimes(1);
    const [providerArg, input] = mockedCallProvider.mock.calls[0];
    expect(providerArg).toBe("gemini");
    expect(input.model).toBe("gemini-2.5-flash"); // config default
    expect(input.mediaType).toBe("image/png"); // default
    expect(input.apiKey).toBe("k");
    expect(input.prompt).toMatch(/Tailwind/i); // react-tailwind default

    const text = (r.content[0] as { text: string }).text;
    expect(text).toBe("const x = 1;\nexport default x;");
    expect(r.structuredContent).toEqual({ code: text, language: "tsx" });
  });

  it("honors per-call model override", async () => {
    process.env.TEST_API_KEY = "k";
    mockedCallProvider.mockResolvedValueOnce("ok");
    await handleCall({ image: "AAA=", model: "gemini-1.5-pro" }, config);
    expect(mockedCallProvider.mock.calls[0][1].model).toBe("gemini-1.5-pro");
  });

  it("honors framework=react option", async () => {
    process.env.TEST_API_KEY = "k";
    mockedCallProvider.mockResolvedValueOnce("ok");
    await handleCall({ image: "AAA=", framework: "react" }, config);
    expect(mockedCallProvider.mock.calls[0][1].prompt).toMatch(/inline `style=/);
  });

  it("surfaces ProviderError as an isError result with message passed through verbatim", async () => {
    // ProviderError.message is built by vendorPost as "<Label> <status>: <body>"
    // (e.g. "Gemini 429: Quota exhausted"). The handler used to prefix
    // "<provider> provider error:" again — we removed that to avoid
    // duplicating the vendor label.
    process.env.TEST_API_KEY = "k";
    mockedCallProvider.mockRejectedValueOnce(
      new providers.ProviderError("gemini", "Gemini 429: Quota exhausted", 429),
    );

    const r = await handleCall({ image: "AAA=" }, config);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("Gemini 429: Quota exhausted");
  });

  it("surfaces a generic Error as an isError result", async () => {
    process.env.TEST_API_KEY = "k";
    mockedCallProvider.mockRejectedValueOnce(new Error("network down"));
    const r = await handleCall({ image: "AAA=" }, config);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/network down/);
  });

  it("returns isError when image exceeds the 6 MB cap (matches API route guard)", async () => {
    // Without this guard, a multi-MB paste could pin the spawned MCP
    // process and rack up an unintended provider bill.
    process.env.TEST_API_KEY = "k";
    const huge = "A".repeat(10 * 1024 * 1024); // ~7.5 MB raw, over the cap
    const r = await handleCall({ image: huge }, config);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/exceeds.*MB cap/);
    expect(mockedCallProvider).not.toHaveBeenCalled();
  });
});
