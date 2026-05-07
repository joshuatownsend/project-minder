import "server-only";
import { getSecret } from "./secretsStore";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL } from "./defaults";
import { LLMError } from "./autoTitle";
import type { TitleTurn } from "./autoTitle";

const MAX_TURN_CHARS = 800;
const MAX_DISTILL_TOKENS = 512;

const SYSTEM_PROMPT = `You are summarizing a Claude Code session. Produce a structured distillation with these sections:

**Goal** — 1-2 sentences: what was being attempted.
**Approach** — 2-4 bullet points: how it was tackled.
**Outcome** — 1-2 sentences: what was achieved or left incomplete.
**Key files** — bullet list of files created or significantly modified (if any).

Be concise and factual. Focus on what happened, not general observations about coding.`;

export interface DistillOpts {
  endpoint?: string;
  model?: string;
  turns: TitleTurn[];
}

function isAnthropic(endpoint: string): boolean {
  return endpoint.includes("anthropic.com");
}

function buildUserMessage(turns: TitleTurn[]): string {
  const samples = turns.slice(0, 20).map((t) => {
    const label = t.role === "user" ? "User" : "Assistant";
    return `${label}: ${t.content.slice(0, MAX_TURN_CHARS)}`;
  });
  if (samples.length === 0) return "Empty session.";
  return "Session transcript:\n\n" + samples.join("\n\n");
}

export async function distillSession(opts: DistillOpts): Promise<{ text: string }> {
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
        max_tokens: MAX_DISTILL_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new LLMError(`Anthropic API error: ${err}`, res.status);
    }
    const data = await res.json();
    const text = (data.content?.[0]?.text ?? "").trim();
    if (!text) throw new LLMError("Empty distillation from Anthropic", 502);
    return { text };
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_DISTILL_TOKENS,
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
  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new LLMError("Empty distillation from LLM", 502);
  return { text };
}
