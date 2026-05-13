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
  registerResources(server);

  return server;
}

// Singleton McpServer on globalThis so the heavy registration cost (60+
// `registerTool` / `registerResource` calls plus their Zod schema parsing) is
// paid once per process and survives Next.js HMR module reloads. The
// transport, on the other hand, MUST be created per request — the SDK's
// stateless mode rejects reuse with: "Stateless transport cannot be reused
// across requests. Create a new transport per request."
const g = globalThis as unknown as { __minderMcpServer?: McpServer };

function getServer(): McpServer {
  if (!g.__minderMcpServer) {
    g.__minderMcpServer = buildMcpServer();
  }
  return g.__minderMcpServer;
}

// Per-request transport handler. The route's GET/POST/DELETE all funnel here.
// We build a fresh transport, connect the cached server to it, and let the
// SDK take over. After `handleRequest` resolves, the transport is single-use
// and can be discarded.
export async function handleMcpRequest(req: Request): Promise<Response> {
  const server = getServer();
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
    // Detach the transport from the server so the next request gets a
    // fresh attachment. McpServer.connect() replaces the transport
    // each call, so an explicit close keeps the bookkeeping clean.
    await transport.close().catch(() => undefined);
  }
}

// Test-only entry point — lets the Vitest suite build an isolated server
// instance to connect to an InMemoryTransport pair (no HTTP involved).
export function buildMcpServerForTests(): Promise<McpServer> {
  return Promise.resolve(buildMcpServer());
}
