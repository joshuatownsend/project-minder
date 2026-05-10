// Screenshot-to-React stdio MCP server.
//
// Spawned by Claude Code as a stdio child process. Exposes one tool —
// `convert_screenshot_to_react` — that takes a base64-encoded image and
// returns a self-contained React TypeScript component string.
//
// API keys are NEVER read from any config file — only from process.env
// at request time, named by the configured `apiKeyEnvVar`. If the env
// var is unset, the tool returns a structured MCP error result with a
// hint, never a 200 with garbage. Provider/model defaults are baked in
// at spawn time via env overrides (see `resolveConfig` below).
//
// Build: `npm run build:mcp-screenshot` produces
// `dist/mcp/screenshot-to-code/index.mjs`. Wire into Claude Code with
// `claude mcp add screenshot-to-code -- node /abs/path/to/index.mjs`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPrompt, cleanCodeBlock, type Framework, type Variant } from "./prompts.js";
import {
  callProvider,
  DEFAULT_ENV_VAR,
  DEFAULT_MODEL,
  ProviderError,
  type ProviderId,
} from "./providers.js";

const TOOL_NAME = "convert_screenshot_to_react";

const TOOL_INPUT_SHAPE = {
  image: z
    .string()
    .min(1)
    .describe("Base64-encoded PNG, JPEG, or WebP. Do not include the `data:` prefix."),
  mediaType: z
    .enum(["image/png", "image/jpeg", "image/webp"])
    .optional()
    .describe("MIME type of the image (defaults to image/png)."),
  framework: z
    .enum(["react", "react-tailwind"])
    .optional()
    .describe("Output styling. Default: react-tailwind."),
  variant: z
    .enum(["verbose", "minimal"])
    .optional()
    .describe(
      "verbose adds prop-driven sub-components; minimal is a single function component. Default: minimal.",
    ),
  model: z
    .string()
    .optional()
    .describe("Override the configured model id for this single call."),
};

type ToolArgs = {
  image: string;
  mediaType?: "image/png" | "image/jpeg" | "image/webp";
  framework?: Framework;
  variant?: Variant;
  model?: string;
};

export interface ServerConfig {
  provider: ProviderId;
  model: string;
  apiKeyEnvVar: string;
}

export function resolveConfig(): ServerConfig {
  const provider = (process.env.SCREENSHOT_PROVIDER ?? "gemini") as ProviderId;
  if (provider !== "gemini" && provider !== "openai" && provider !== "anthropic") {
    throw new Error(
      `Unknown SCREENSHOT_PROVIDER "${provider}". Expected one of: gemini, openai, anthropic.`,
    );
  }
  const model = process.env.SCREENSHOT_MODEL ?? DEFAULT_MODEL[provider];
  const apiKeyEnvVar = process.env.SCREENSHOT_API_KEY_ENV ?? DEFAULT_ENV_VAR[provider];
  return { provider, model, apiKeyEnvVar };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function handleCall(rawArgs: unknown, config: ServerConfig): Promise<CallToolResult> {
  if (!rawArgs || typeof rawArgs !== "object") {
    return errorResult("Tool arguments must be an object.");
  }
  const args = rawArgs as ToolArgs;
  if (typeof args.image !== "string" || args.image.length === 0) {
    return errorResult("`image` is required and must be a base64 string.");
  }

  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) {
    return errorResult(
      `Missing API key. Set environment variable ${config.apiKeyEnvVar} before calling this tool.`,
    );
  }

  const framework: Framework = args.framework ?? "react-tailwind";
  const variant: Variant = args.variant ?? "minimal";
  const mediaType = args.mediaType ?? "image/png";
  const model = args.model ?? config.model;
  const prompt = buildPrompt({ framework, variant });

  try {
    const raw = await callProvider(config.provider, {
      base64: args.image,
      mediaType,
      prompt,
      model,
      apiKey,
    });
    const code = cleanCodeBlock(raw);
    return {
      content: [{ type: "text", text: code }],
      structuredContent: { code, language: "tsx" },
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return errorResult(`${err.provider} provider error: ${err.message}`);
    }
    return errorResult(`Tool execution failed: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const server = new McpServer({
    name: "screenshot-to-code",
    version: "0.1.0",
  });

  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Convert a UI screenshot into a self-contained React TypeScript component. Returns the code with markdown fences and any provider preamble stripped.",
      inputSchema: TOOL_INPUT_SHAPE,
    },
    async (args) => handleCall(args, config),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Top-level await isn't safe inside a CJS-wrapped ESM bundle for Node 20.
// Use the classic pattern: kick off main() and crash-loud on rejection so
// Claude Code restarts the spawn instead of silently hanging.
main().catch((err) => {
  // stderr only — stdout is reserved for JSON-RPC frames.
  // eslint-disable-next-line no-console
  console.error("[screenshot-to-code] fatal:", err);
  process.exit(1);
});
