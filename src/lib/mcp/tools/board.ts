import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { addIssue, setIssueStatus, BoardWriteError } from "@/lib/boardWriter";
import { promoteBoardIssueToTask } from "@/lib/tasks/boardDelegation";
import { findProjectPathBySlug } from "@/lib/projectPath";
import { invalidateCache } from "@/lib/cache";
import type { BoardInfo } from "@/lib/types";
import { SlugSchema, BoardStatusSchema, BoardPrioritySchema } from "../schemas";
import { jsonResult, errorResult } from "../result";

// ── MCP write-bridge for the board (Portfolio Command Deck — Phase 2, Group B)
//
// Four tools let a running Claude Code session push work into a project's
// canonical `BOARD.md` without leaving the terminal:
//   • board_create_issue   — add an issue under an epic or the Inbox
//   • board_log_finding    — add a "(finding) …" Inbox row at status `triage`
//   • board_postpone       — snooze an issue to `backlog` (or any status)
//   • board_promote_to_task — bridge an issue into ~/.minder/tasks.db
//
// Like the existing write tools (toggle-manual-step, refresh-*), these call the
// Phase 1 writer (`boardWriter`) and the Group A promote lib directly — no HTTP
// loopback — then `invalidateCache()` so a follow-up read reflects the write.
// Slug → parent path resolves via `findProjectPathBySlug`; the writer
// canonicalizes again internally, so a worktree path can't fragment the board.
// Provenance (`sessionId`/`worktree`) is supplied by the agent as optional
// inputs because the MCP transport is stateless and can't auto-derive them.

const EMPTY_BOARD: BoardInfo = { epics: [], inbox: [], total: 0 };

/**
 * Resolve a slug → parent project path, run `fn`, and flatten any failure to an
 * MCP error result. An unknown slug and a `BoardWriteError` (e.g. NOT_FOUND on a
 * stale issue id, BAD_VALUE on an out-of-enum status) both surface as
 * `isError:true` with the message — the model re-reads the text rather than
 * branching on HTTP status codes (the REST route's job).
 */
async function withProject(
  slug: string,
  fn: (projectPath: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) return errorResult(`No project with slug '${slug}'.`);
  try {
    return await fn(projectPath);
  } catch (err) {
    if (err instanceof BoardWriteError) {
      return errorResult(`${err.message} (${err.code})`);
    }
    return errorResult(`Board write failed: ${(err as Error).message}`);
  }
}

export function registerBoardTools(server: McpServer): void {
  server.registerTool(
    "board_create_issue",
    {
      title: "Create a board issue",
      description:
        "Add an issue to a project's BOARD.md — under an epic (pass its `^e-` " +
        "id as `epicId`) or, by default, the Inbox. Pass `sessionId`/`worktree` " +
        "to stamp `~session:`/`@wt:` provenance. Returns the re-parsed board.",
      inputSchema: {
        slug: SlugSchema,
        title: z
          .string()
          .min(1)
          .max(300)
          .describe("Issue title (single line; newlines are collapsed)"),
        epicId: z
          .string()
          .optional()
          .describe("Target epic '^e-' id; omit to land the issue in the Inbox"),
        status: BoardStatusSchema.optional().describe("Initial status (default todo)"),
        priority: BoardPrioritySchema.optional(),
        labels: z.array(z.string()).optional().describe("Labels (slug-normalized)"),
        sessionId: z
          .string()
          .optional()
          .describe("Calling session id → ~session: provenance"),
        worktree: z
          .string()
          .optional()
          .describe("Worktree branch hint → @wt: provenance"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (a) =>
      withProject(a.slug, async (p) => {
        const board = await addIssue(p, {
          title: a.title,
          epicId: a.epicId,
          status: a.status,
          priority: a.priority,
          labels: a.labels,
          sessionId: a.sessionId,
          worktree: a.worktree,
        });
        invalidateCache();
        return jsonResult(board ?? EMPTY_BOARD);
      }),
  );

  server.registerTool(
    "board_log_finding",
    {
      title: "Log a finding to the board Inbox",
      description:
        "Record an agent-discovered finding in the project's BOARD.md Inbox: " +
        "creates an issue titled `(finding) <text>` at status `triage` so the " +
        "developer can triage it later. Pass `sessionId`/`worktree` to stamp " +
        "provenance. Returns the re-parsed board.",
      inputSchema: {
        slug: SlugSchema,
        finding: z
          .string()
          .min(1)
          .max(300)
          .describe("The finding text (prefixed with '(finding) ' automatically)"),
        priority: BoardPrioritySchema.optional(),
        labels: z.array(z.string()).optional(),
        sessionId: z
          .string()
          .optional()
          .describe("Calling session id → ~session: provenance"),
        worktree: z
          .string()
          .optional()
          .describe("Worktree branch hint → @wt: provenance"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (a) =>
      withProject(a.slug, async (p) => {
        const board = await addIssue(p, {
          title: `(finding) ${a.finding}`,
          status: "triage",
          priority: a.priority,
          labels: a.labels,
          sessionId: a.sessionId,
          worktree: a.worktree,
        });
        invalidateCache();
        return jsonResult(board ?? EMPTY_BOARD);
      }),
  );

  server.registerTool(
    "board_postpone",
    {
      title: "Postpone (snooze) a board issue",
      description:
        "Move an issue out of the active lanes by setting its status — defaults " +
        "to `backlog` (the board has no date field, so snooze == backlog). Pass " +
        "an explicit `status` for any other target. Returns the re-parsed board.",
      inputSchema: {
        slug: SlugSchema,
        id: z.string().min(1).describe("Issue '^i-' id (without the caret)"),
        status: BoardStatusSchema.optional().describe(
          "Status to set; defaults to backlog",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (a) =>
      withProject(a.slug, async (p) => {
        const board = await setIssueStatus(p, a.id, a.status ?? "backlog");
        invalidateCache();
        return jsonResult(board ?? EMPTY_BOARD);
      }),
  );

  server.registerTool(
    "board_promote_to_task",
    {
      title: "Promote a board issue to an executable task",
      description:
        "Bridge a BOARD.md issue into a row in ~/.minder/tasks.db that the task " +
        "dispatcher runs. The issue flips to `doing` on promote and (on the " +
        "dispatcher's completion hook) back to `done`. Returns `{ taskId, board }`.",
      inputSchema: {
        slug: SlugSchema,
        id: z.string().min(1).describe("Issue '^i-' id (without the caret)"),
        assignedSkill: z
          .string()
          .optional()
          .describe("Skill the dispatcher should run the task with"),
        model: z.string().optional().describe("Model override for the task"),
        priority: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Task priority 1–5 (NOT the board's high/med/low priority)"),
        riskLevel: z.enum(["low", "medium", "high"]).optional(),
        sessionId: z
          .string()
          .optional()
          .describe("Calling session id → task.metadata provenance"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (a) =>
      withProject(a.slug, async (p) => {
        const result = await promoteBoardIssueToTask({
          projectPath: p,
          issueId: a.id,
          assignedSkill: a.assignedSkill,
          model: a.model,
          priority: a.priority,
          riskLevel: a.riskLevel,
          sessionId: a.sessionId,
        });
        invalidateCache();
        return jsonResult(result);
      }),
  );
}
