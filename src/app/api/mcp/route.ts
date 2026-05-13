import { handleMcpRequest } from "@/lib/mcp/server";

// Force the Node.js runtime — the MCP server reaches into native modules
// (better-sqlite3 via @/lib/db/connection, fs watchers in the scanner)
// that don't run on the edge runtime.
export const runtime = "nodejs";

// Disable any caching layer — MCP request/response content varies per call
// even when the protocol session is stateless.
export const dynamic = "force-dynamic";

// Each method delegates to the same per-request transport handler. The SDK's
// `WebStandardStreamableHTTPServerTransport` interprets HTTP method:
//   POST   = JSON-RPC message (tool calls, resource reads, etc.)
//   GET    = open SSE event stream for server-initiated notifications
//   DELETE = explicit session termination (no-op in stateless mode)
async function handle(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
