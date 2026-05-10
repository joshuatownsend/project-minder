import { NextRequest, NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { callProvider, ProviderError } from "@/mcp/screenshot-to-code/providers";
import { buildPrompt, cleanCodeBlock } from "@/mcp/screenshot-to-code/prompts";
import {
  FRAMEWORK_SET,
  isMember,
  MEDIA_TYPE_SET,
  PROVIDER_DEFAULT_ENV_VAR,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_SET,
  VARIANT_SET,
  type Provider,
} from "@/mcp/screenshot-to-code/constants";

// Proxy that the in-app playground hits. Mirrors the bundled MCP server
// (src/mcp/screenshot-to-code/) so dropping a screenshot in the
// playground exercises the same provider + model the MCP tool would, but
// without the JSON-RPC + spawn overhead.
//
// API keys are NEVER read from .minder.json — the route resolves them
// from process.env at request time. A missing env var returns 412
// Precondition Failed with a hint; the caller never sees the key value.

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB raw — providers cap around this anyway

interface RequestBody {
  image?: unknown;
  mediaType?: unknown;
  framework?: unknown;
  variant?: unknown;
  model?: unknown;
  provider?: unknown;
}

function errorJson(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return errorJson(400, "INVALID_BODY", "Body must be valid JSON.");
  }

  const image = typeof body.image === "string" ? body.image : "";
  if (image.length === 0) {
    return errorJson(400, "INVALID_BODY", "`image` is required (base64-encoded, no data: prefix).");
  }
  // Rough byte-size guard. base64 length × 3/4 ≈ raw bytes.
  if ((image.length * 3) / 4 > MAX_IMAGE_BYTES) {
    return errorJson(
      413,
      "IMAGE_TOO_LARGE",
      `Image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB cap.`,
    );
  }

  // Resolve config: explicit body fields override .minder.json which
  // overrides per-provider defaults. Nothing here reads or stores keys.
  const config = await readConfig();
  const provider: Provider = isMember(body.provider, PROVIDER_SET)
    ? body.provider
    : (config.screenshotToCode?.provider ?? "gemini");
  const model = pickString(body.model, config.screenshotToCode?.model) ?? PROVIDER_DEFAULT_MODEL[provider];
  // Only adopt the configured env-var name when the configured provider
  // matches the resolved provider — otherwise we'd hand a Gemini key to
  // OpenAI (or vice versa) when the body overrides provider.
  const apiKeyEnvVar =
    config.screenshotToCode?.provider === provider && config.screenshotToCode?.apiKeyEnvVar
      ? config.screenshotToCode.apiKeyEnvVar
      : PROVIDER_DEFAULT_ENV_VAR[provider];

  const framework = isMember(body.framework, FRAMEWORK_SET) ? body.framework : "react-tailwind";
  const variant = isMember(body.variant, VARIANT_SET) ? body.variant : "minimal";
  const mediaType = isMember(body.mediaType, MEDIA_TYPE_SET) ? body.mediaType : "image/png";

  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    return errorJson(
      412,
      "API_KEY_MISSING",
      `Environment variable ${apiKeyEnvVar} is not set on the dev server. Restart the dev server with the key exported.`,
    );
  }

  const prompt = buildPrompt({ framework, variant });

  try {
    const raw = await callProvider(provider, {
      base64: image,
      mediaType,
      prompt,
      model,
      apiKey,
    });
    const code = cleanCodeBlock(raw);
    return NextResponse.json({
      ok: true,
      code,
      language: "tsx",
      provider,
      model,
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      return errorJson(status, "PROVIDER_ERROR", `${err.provider}: ${err.message}`);
    }
    return errorJson(500, "INTERNAL", (err as Error).message);
  }
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
