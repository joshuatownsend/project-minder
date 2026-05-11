import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// The route depends on `readConfig` (which reads .minder.json) and
// `callProvider` (which would hit the network). Mock both — the route's
// logic under test is the env-key precondition + body validation +
// provider/model resolution + ProviderError → status mapping.

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
}));

vi.mock("@/mcp/screenshot-to-code/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/screenshot-to-code/providers")>();
  return {
    ...actual,
    callProvider: vi.fn(),
  };
});

import { POST } from "@/app/api/screenshot-to-code/route";
import * as configMod from "@/lib/config";
import * as providers from "@/mcp/screenshot-to-code/providers";
import type { MinderConfig } from "@/lib/types";

const mockedReadConfig = vi.mocked(configMod.readConfig);
const mockedCallProvider = vi.mocked(providers.callProvider);

const baseConfig: MinderConfig = {
  statuses: {},
  hidden: [],
  portOverrides: {},
  devRoot: "",
  pinnedSlugs: [],
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4100/api/screenshot-to-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockedReadConfig.mockReset();
  mockedCallProvider.mockReset();
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("POST /api/screenshot-to-code", () => {
  it("returns 400 INVALID_BODY when image missing", async () => {
    mockedReadConfig.mockResolvedValueOnce(baseConfig);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BODY");
  });

  it("returns 412 API_KEY_MISSING when env var unset", async () => {
    mockedReadConfig.mockResolvedValueOnce(baseConfig);
    const res = await POST(makeRequest({ image: "AAA=" }));
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("API_KEY_MISSING");
    // Default provider is gemini → default env var is GOOGLE_API_KEY.
    expect(body.error.message).toMatch(/GOOGLE_API_KEY/);
    expect(mockedCallProvider).not.toHaveBeenCalled();
  });

  it("returns 200 with cleaned code on happy path", async () => {
    process.env.GOOGLE_API_KEY = "k";
    mockedReadConfig.mockResolvedValueOnce(baseConfig);
    mockedCallProvider.mockResolvedValueOnce("```tsx\nconst x = 1;\nexport default x;\n```");

    const res = await POST(makeRequest({ image: "AAA=" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; provider: string; model: string };
    expect(body.ok).toBe(true);
    expect(body.code).toBe("const x = 1;\nexport default x;");
    expect(body.provider).toBe("gemini");
    expect(body.model).toBe("gemini-2.5-flash");
  });

  it("uses provider/model from .minder.json when not overridden in body", async () => {
    process.env.OPENAI_API_KEY = "k";
    mockedReadConfig.mockResolvedValueOnce({
      ...baseConfig,
      screenshotToCode: { provider: "openai", model: "gpt-4o-mini", apiKeyEnvVar: "OPENAI_API_KEY" },
    });
    mockedCallProvider.mockResolvedValueOnce("hi");

    const res = await POST(makeRequest({ image: "AAA=" }));
    expect(res.status).toBe(200);
    const [providerArg, input] = mockedCallProvider.mock.calls[0];
    expect(providerArg).toBe("openai");
    expect(input.model).toBe("gpt-4o-mini");
  });

  it("body fields override config fields", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    mockedReadConfig.mockResolvedValueOnce({
      ...baseConfig,
      screenshotToCode: { provider: "openai", model: "gpt-4o", apiKeyEnvVar: "OPENAI_API_KEY" },
    });
    mockedCallProvider.mockResolvedValueOnce("hi");

    const res = await POST(
      makeRequest({ image: "AAA=", provider: "anthropic", model: "claude-sonnet-4-5" }),
    );
    expect(res.status).toBe(200);
    const [providerArg, input] = mockedCallProvider.mock.calls[0];
    expect(providerArg).toBe("anthropic");
    expect(input.model).toBe("claude-sonnet-4-5");
    // Anthropic's default env var, not the OPENAI_API_KEY from config.
    expect(input.apiKey).toBe("k");
  });

  it("maps ProviderError status onto the response without double-prefixing the vendor label", async () => {
    process.env.GOOGLE_API_KEY = "k";
    mockedReadConfig.mockResolvedValueOnce(baseConfig);
    // ProviderError.message already starts with the vendor label
    // (callers in providers.ts always do `${labelFor(provider)} <status>:`).
    // The route used to prefix `${err.provider}:` again, producing
    // `gemini: Gemini 401: …`. Verify the double-prefix is gone.
    mockedCallProvider.mockRejectedValueOnce(
      new providers.ProviderError("gemini", "Gemini 429: Quota exhausted", 429),
    );

    const res = await POST(makeRequest({ image: "AAA=" }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("PROVIDER_ERROR");
    expect(body.error.message).toBe("Gemini 429: Quota exhausted");
    expect(body.error.message).not.toMatch(/^gemini:/);
  });

  it("re-validates config.screenshotToCode.provider against PROVIDER_SET (typo falls back to gemini)", async () => {
    // .minder.json could legally hold any string; an invalid provider
    // would otherwise cascade into undefined model/env-var lookups
    // and produce a misleading API_KEY_MISSING.
    process.env.GOOGLE_API_KEY = "k";
    mockedReadConfig.mockResolvedValueOnce({
      ...baseConfig,
      screenshotToCode: {
        provider: "open-ai" as unknown as "openai",
        model: "gpt-4o",
        apiKeyEnvVar: "OPENAI_API_KEY",
      },
    });
    mockedCallProvider.mockResolvedValueOnce("ok");

    const res = await POST(makeRequest({ image: "AAA=" }));
    expect(res.status).toBe(200);
    const [providerArg, input] = mockedCallProvider.mock.calls[0];
    expect(providerArg).toBe("gemini");
    expect(input.model).toBe("gemini-2.5-flash");
    expect(input.apiKey).toBe("k");
  });

  it("returns 413 when image exceeds the size cap", async () => {
    mockedReadConfig.mockResolvedValueOnce(baseConfig);
    process.env.GOOGLE_API_KEY = "k";
    // 10 MB of base64 → ~7.5 MB raw, over the 6 MB cap.
    const huge = "A".repeat(10 * 1024 * 1024);
    const res = await POST(makeRequest({ image: huge }));
    expect(res.status).toBe(413);
  });
});
