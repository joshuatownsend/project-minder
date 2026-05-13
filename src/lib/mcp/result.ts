import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Shared result helpers. The MCP spec requires every tool result to include
// `content` (a list of typed content blocks). Even when the meaningful payload
// is JSON, we serialize it as a text block — Claude reads the text directly
// and the SDK's `outputSchema` validation runs against `structuredContent`
// (which we omit since none of our tools define output schemas yet).
//
// Centralizing this avoids 30+ near-identical `JSON.stringify(..., null, 2)`
// call sites and gives us one place to wire in size limits / truncation
// later if any tool's output blows past the model's context.

export function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
