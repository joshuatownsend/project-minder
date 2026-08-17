import type { UserConfig } from "@/lib/types";

/**
 * Synthetic user-scope Claude config for demo mode — the `~/.claude` half of
 * `/api/claude-config`, which powers `/hooks` and `/config`.
 *
 * The project-scope half of that route was already safe (it comes from
 * `scanAllProjects()`, which is demo-guarded); `getUserConfig()` was not, and
 * it carries the most identifying material on the route: absolute
 * `sourcePath`s under the real home, the full text of every hook command, the
 * installed plugin list with repo URLs, and every configured MCP server.
 *
 * Note this route was classified as *covered* by a naive import-graph audit,
 * because a module it transitively imports contains a `demoMode()` call.
 * Reaching a guard is not being guarded — see `docs/demo-mode-coverage.md`.
 */
const DEMO_HOME = "C:\\Users\\demo\\.claude";

export function demoUserConfig(): UserConfig {
  return {
    hooks: {
      entries: [
        {
          event: "PreToolUse",
          matcher: "Bash",
          source: "user",
          sourcePath: `${DEMO_HOME}\\settings.json`,
          commands: [{ type: "command", command: "node scripts/guard-destructive.mjs", timeout: 5 }],
        },
        {
          event: "PostToolUse",
          matcher: "Edit|Write",
          source: "user",
          sourcePath: `${DEMO_HOME}\\settings.json`,
          commands: [{ type: "command", command: "pnpm exec prettier --write $CLAUDE_FILE" }],
        },
        {
          event: "SessionStart",
          source: "user",
          sourcePath: `${DEMO_HOME}\\settings.json`,
          commands: [{ type: "command", command: "node scripts/load-context.mjs" }],
        },
        {
          event: "Stop",
          source: "user",
          sourcePath: `${DEMO_HOME}\\settings.json`,
          commands: [{ type: "command", command: "node scripts/append-insights.mjs", timeout: 10 }],
        },
      ],
    },
    mcpServers: {
      servers: [
        {
          name: "github",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          // Key names only, never values — same rule the real reader follows.
          envKeys: ["GITHUB_TOKEN"],
          source: "user",
          sourcePath: `${DEMO_HOME}\\settings.json`,
        },
        {
          name: "linear",
          transport: "http",
          url: "https://mcp.linear.app/sse",
          source: "user",
          sourcePath: `${DEMO_HOME}\\settings.json`,
        },
        {
          name: "postgres",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-postgres"],
          envKeys: ["DATABASE_URL"],
          source: "user",
          sourcePath: `${DEMO_HOME}\\settings.json`,
          disabled: true,
        },
      ],
    },
    plugins: {
      plugins: [
        {
          name: "pr-review-toolkit",
          marketplace: "community",
          enabled: true,
          blocked: false,
          version: "1.4.0",
          installedAt: "2026-05-02T09:14:00.000Z",
          lastUpdated: "2026-07-30T16:02:00.000Z",
          installPath: `${DEMO_HOME}\\plugins\\pr-review-toolkit`,
        },
        {
          name: "changelog",
          marketplace: "community",
          enabled: true,
          blocked: false,
          version: "0.9.2",
          installedAt: "2026-06-18T11:40:00.000Z",
          installPath: `${DEMO_HOME}\\plugins\\changelog`,
        },
        {
          name: "legacy-formatter",
          marketplace: "community",
          enabled: false,
          blocked: true,
          version: "0.2.0",
          installPath: `${DEMO_HOME}\\plugins\\legacy-formatter`,
        },
      ],
    },
    settingsKeys: [
      { keyPath: "model", value: "claude-opus-5" },
      { keyPath: "outputStyle", value: "explanatory" },
      { keyPath: "statusLine", value: { type: "command", command: "node scripts/statusline.mjs" } },
      { keyPath: "permissions", value: { allow: ["Bash(pnpm test:*)"], deny: ["Bash(rm -rf:*)"] } },
    ],
  };
}
