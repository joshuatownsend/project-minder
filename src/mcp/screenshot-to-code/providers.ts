// Three vision-LLM providers, each via their documented REST endpoint.
//
// Adding the official SDKs (@google/generative-ai, openai, @anthropic-ai/sdk)
// would pull in hundreds of KB to support what is, for our purposes, one
// POST per call. Direct `fetch` keeps the bundled MCP server tiny and the
// three vendor versions independently pinnable through whatever URL we hit.
//
// Each adapter takes the same `ProviderInput` and returns the raw text body
// that came back from the model. Markdown-fence stripping is the caller's
// job (see `cleanCodeBlock` in prompts.ts) so each adapter stays focused
// on the wire format.

import {
  PROVIDER_DEFAULT_ENV_VAR,
  PROVIDER_DEFAULT_MODEL,
  type Provider,
} from "./constants";

export type ProviderId = Provider;

export interface ProviderInput {
  /** Base64-encoded image (no `data:` prefix). */
  base64: string;
  /** MIME type, e.g. "image/png" or "image/jpeg". */
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** The full system+user prompt to send. */
  prompt: string;
  /** Vendor-specific model id. */
  model: string;
  /** API key. The MCP server reads this from process.env per request and
   *  never persists it to disk. */
  apiKey: string;
}

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status?: number;
  constructor(provider: ProviderId, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
  }
}

/** Dispatch a single image-to-code request to the named provider. */
export async function callProvider(provider: ProviderId, input: ProviderInput): Promise<string> {
  switch (provider) {
    case "gemini":
      return callGemini(input);
    case "openai":
      return callOpenAI(input);
    case "anthropic":
      return callAnthropic(input);
  }
}

/** Shared `fetch` envelope: POST a JSON body, throw `ProviderError` with the
 *  vendor's status code + body text on non-2xx, otherwise hand back the
 *  parsed JSON for the caller to extract the model output from. The
 *  vendor-specific request shapes and response parsers stay in their own
 *  functions; this just dedups the error path that all three share. */
async function vendorPost<T>(
  provider: ProviderId,
  url: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      provider,
      `${labelFor(provider)} ${res.status}: ${text || res.statusText}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

function labelFor(provider: ProviderId): string {
  switch (provider) {
    case "gemini":
      return "Gemini";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
  }
}

// ─── Gemini ──────────────────────────────────────────────────────────────
//
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
// Auth: ?key=<API_KEY>
// Image: inlineData { mimeType, data }
// Response: candidates[0].content.parts[].text concatenated.

async function callGemini(input: ProviderInput): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent` +
    `?key=${encodeURIComponent(input.apiKey)}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: input.prompt },
          { inlineData: { mimeType: input.mediaType, data: input.base64 } },
        ],
      },
    ],
  };

  const json = await vendorPost<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }>("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new ProviderError("gemini", "Gemini returned an empty response.");
  return text;
}

// ─── OpenAI ──────────────────────────────────────────────────────────────
//
// Endpoint: https://api.openai.com/v1/chat/completions
// Auth: Authorization: Bearer <API_KEY>
// Image: content[].type === "image_url" { image_url: { url: "data:<mt>;base64,<…>" } }
// Response: choices[0].message.content (string)

async function callOpenAI(input: ProviderInput): Promise<string> {
  const dataUrl = `data:${input.mediaType};base64,${input.base64}`;
  const body = {
    model: input.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: input.prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  const json = await vendorPost<{
    choices?: Array<{ message?: { content?: string } }>;
  }>("openai", "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ProviderError("openai", "OpenAI returned an empty response.");
  return text;
}

// ─── Anthropic ───────────────────────────────────────────────────────────
//
// Endpoint: https://api.anthropic.com/v1/messages
// Auth: x-api-key: <API_KEY>; anthropic-version: 2023-06-01
// Image: content[].type === "image" { source: { type: "base64", media_type, data } }
// Response: content[0].text

async function callAnthropic(input: ProviderInput): Promise<string> {
  const body = {
    model: input.model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: input.mediaType, data: input.base64 },
          },
          { type: "text", text: input.prompt },
        ],
      },
    ],
  };

  const json = await vendorPost<{
    content?: Array<{ type?: string; text?: string }>;
  }>("anthropic", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const text = json.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  if (!text) throw new ProviderError("anthropic", "Anthropic returned an empty response.");
  return text;
}

// Re-exports for callers that previously imported the defaults from this
// module. The canonical source is `./constants` so the type union and the
// runtime tables stay in lockstep.
export { PROVIDER_DEFAULT_MODEL as DEFAULT_MODEL, PROVIDER_DEFAULT_ENV_VAR as DEFAULT_ENV_VAR };
