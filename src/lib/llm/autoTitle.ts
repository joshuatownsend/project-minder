import "server-only";
import { getSecret } from "./secretsStore";

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_PROMPT_CHARS = 500;
const MAX_TITLE_TOKENS = 64;

const SYSTEM_PROMPT =
  "Generate a concise 4-8 word title for this Claude Code session. Focus on what was attempted, not the outcome. Reply with only the title, no quotes.";

export interface TitleTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateTitleOpts {
  endpoint?: string;
  model?: string;
  turns: TitleTurn[];
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "LLMError";
  }
}

function isAnthropic(endpoint: string): boolean {
  return endpoint.includes("anthropic.com");
}

function buildUserMessage(turns: TitleTurn[]): string {
  const samples = turns
    .filter((t) => t.role === "user")
    .slice(0, 3)
    .map((t) => t.content.slice(0, MAX_PROMPT_CHARS));
  if (samples.length === 0) return "Empty session.";
  return "Session messages:\n" + samples.join("\n\n");
}

export async function generateTitle(opts: GenerateTitleOpts): Promise<{ title: string }> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = await getSecret("llm.api_key");
  if (!apiKey) throw new LLMError("LLM API key not configured", 400);

  const userContent = buildUserMessage(opts.turns);

  if (isAnthropic(endpoint)) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TITLE_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new LLMError(`Anthropic API error: ${err}`, res.status);
    }
    const data = await res.json();
    const title = (data.content?.[0]?.text ?? "").trim();
    if (!title) throw new LLMError("Empty title from Anthropic", 502);
    return { title };
  }

  // OpenAI-compatible shape.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TITLE_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new LLMError(`LLM API error: ${err}`, res.status);
  }
  const data = await res.json();
  const title = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!title) throw new LLMError("Empty title from LLM", 502);
  return { title };
}
