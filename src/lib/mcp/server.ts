import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { registerProjectTools } from "./tools/projects";
import { registerUsageTools } from "./tools/usage";
import { registerSessionTools } from "./tools/sessions";
import { registerCatalogTools } from "./tools/catalog";
import { registerManualStepsTools } from "./tools/manualSteps";
import { registerInsightsTools } from "./tools/insights";
import { registerGitTools } from "./tools/git";
import { registerStatsTools } from "./tools/stats";
import { registerOtelTools } from "./tools/otel";
import { registerDevServerTools } from "./tools/devServers";
import { registerClaudeStatusTools } from "./tools/claudeStatus";
import { registerResources } from "./resources";

// Bind the transport's DNS-rebinding protection to the dev-server's port.
// The Next.js dev script hard-codes 4100 and the start script does too; if
// either ever changes, update this constant and the docs/help/mcp-server.md
// example URL in lockstep.
const ALLOWED_HOSTS = ["localhost:4100", "127.0.0.1:4100"];
const ALLOWED_ORIGINS = ["http://localhost:4100", "http://127.0.0.1:4100"];

// Build a fully-registered McpServer instance. Tools and resources are
// stateless functions over Project Minder's lib layer, so the same server
// instance can serve any number of concurrent requests safely — only the
// transport is per-request (a stateless-mode SDK constraint).
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "project-minder",
      title: "Project Minder",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions:
        "Project Minder MCP server. Tools and resources expose the data " +
        "Project Minder aggregates about local projects: token usage, " +
        "Claude Code sessions, agents/skills catalogs, OTEL telemetry, " +
        "manual steps, insights, git status, and portfolio statistics. " +
        "All data is read from the user's local filesystem and SQLite " +
        "index — no network calls are made.",
    }
  );

  registerProjectTools(server);
  registerUsageTools(server);
  registerSessionTools(server);
  registerCatalogTools(server);
  registerManualStepsTools(server);
  registerInsightsTools(server);
  registerGitTools(server);
  registerStatsTools(server);
  registerOtelTools(server);
  registerDevServerTools(server);
  registerClaudeStatusTools(server);
  registerResources(server);

  return server;
}

// Per-request handler — fresh McpServer AND fresh transport per call.
// We can't reuse a process-global McpServer because `server.connect(transport)`
// replaces the active transport; if two `/api/mcp` requests overlap, the
// second's `connect` rebinds the SDK's message router onto its own transport
// and the first request's response can't route back. Per-request isolation
// is the SDK's recommended pattern for stateless HTTP. Registration is cheap
// metadata setup (no I/O, no expensive Zod parsing beyond what's cached at
// module load).
export async function handleMcpRequest(req: Request): Promise<Response> {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — each request stands alone. The dashboard provides
    // live UI for anything that wants subscriptions; MCP clients can
    // re-ask if they need fresh data.
    sessionIdGenerator: undefined,
    // Plain JSON responses (no SSE). None of our tools stream progress.
    enableJsonResponse: true,
    // DNS rebinding protection. The only realistic security boundary for
    // a localhost server that a malicious site might try to reach via
    // DNS rebinding. The Host/Origin must match the dev-server's port.
    allowedHosts: ALLOWED_HOSTS,
    allowedOrigins: ALLOWED_ORIGINS,
    enableDnsRebindingProtection: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Close transport + server so per-request resources don't leak. The
    // server is single-use under this design; the SDK's Server.close()
    // is synchronous and cheap.
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

// Test-only entry point — lets the Vitest suite build an isolated server
// instance to connect to an InMemoryTransport pair (no HTTP involved).
export function buildMcpServerForTests(): Promise<McpServer> {
  return Promise.resolve(buildMcpServer());
}
