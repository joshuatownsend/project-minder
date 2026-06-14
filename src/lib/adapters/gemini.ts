import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { SessionAdapter, SessionFile } from "./types";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";
import type { SessionTurnsMeta } from "@/lib/usage/parser";
import { encodeProjectPath } from "@/lib/usage/projectMatch";
import { toSlug } from "@/lib/scanner/claudeConversations";
import { TEXT_CAP, makeBaseTurn } from "./utils";

const ADAPTER_ID = "gemini" as const;

// Empty meta for a missing/unreadable/malformed file. compactBoundaries is
// always [] for Gemini — compact boundaries are a Claude-specific concept.
const EMPTY_META: SessionTurnsMeta = { compactBoundaries: [], cliVersion: null, hasThinking: false };

// ─── project map ─────────────────────────────────────────────────────────────

// Loads ~/.gemini/projects.json and returns projName → folderPath mapping.
// Format: { "projects": { "/path/to/folder": "projName" } }
async function loadProjectMap(geminiHome: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(geminiHome, "projects.json"), "utf-8");
    const data = JSON.parse(raw) as { projects?: Record<string, unknown> };
    if (data.projects && typeof data.projects === "object") {
      for (const [folderPath, projName] of Object.entries(data.projects)) {
        if (typeof projName === "string" && projName && typeof folderPath === "string") {
          map.set(projName, folderPath);
        }
      }
    }
  } catch {
    // projects.json may not exist or be unreadable
  }
  return map;
}

// Newer Gemini CLI versions use hashed directory names and write the actual
// project path into a .project_root file in the same directory.
async function readProjectRoot(projDir: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(projDir, ".project_root"), "utf-8");
    const p = content.trim();
    return p || null;
  } catch {
    return null;
  }
}

// ─── parsing helpers ──────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as unknown[])
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && !Array.isArray(p))
      .filter((p) => typeof p.text === "string" && p.text)
      .map((p) => (p.text as string).trim())
      .join("\n")
      .trim();
  }
  if (typeof (content as Record<string, unknown>).text === "string") {
    return ((content as Record<string, unknown>).text as string).trim();
  }
  return "";
}

// Token values in Gemini session files are per-turn deltas, not cumulative totals.
// If this assumption proves wrong for a specific Gemini CLI version, the fix is
// to add subtraction logic here (same as Codex's subtractRawUsage pattern).
function extractTokens(raw: unknown): { inputTokens: number; outputTokens: number; cacheReadTokens: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  }
  const t = raw as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const rawInput = n(t.input);
  const rawCached = n(t.cached);
  const rawOutput = n(t.output);
  const cacheReadTokens = Math.min(rawCached, rawInput);
  return {
    inputTokens: Math.max(rawInput - cacheReadTokens, 0),
    outputTokens: rawOutput,
    cacheReadTokens,
  };
}

// ─── file parser ──────────────────────────────────────────────────────────────

async function parseGeminiFileWithMeta(
  filePath: string,
  projectDirName: string
): Promise<{ turns: UsageTurn[]; meta: SessionTurnsMeta }> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { turns: [], meta: { ...EMPTY_META } };
  }

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { turns: [], meta: { ...EMPTY_META } };
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return { turns: [], meta: { ...EMPTY_META } };
  }

  if (!Array.isArray(record.messages)) return { turns: [], meta: { ...EMPTY_META } };

  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim()
      ? record.sessionId
      : path.basename(filePath, ".json");

  const sessionTimestamp =
    (typeof record.startTime === "string" && record.startTime.trim() ? record.startTime : null) ??
    (await fs.stat(filePath).then((s) => s.mtime.toISOString()).catch(() => new Date().toISOString()));

  const projectSlug = toSlug(projectDirName);

  const turns: UsageTurn[] = [];
  let hasThinking = false;

  for (const msg of record.messages as unknown[]) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const m = msg as Record<string, unknown>;
    const type = m.type;

    // Use per-message timestamp when present; fall back to session startTime.
    // Gemini sessions can span hours, so per-message timestamps keep hourly
    // and daily analytics accurate.
    const turnTimestamp =
      (typeof m.timestamp === "string" && m.timestamp.trim() ? m.timestamp : null) ??
      sessionTimestamp;

    const baseTurn = () => makeBaseTurn(ADAPTER_ID, turnTimestamp, sessionId, projectSlug, projectDirName);

    if (type === "user") {
      const text = extractTextContent(m.content ?? m.displayContent);
      if (!text) continue;
      turns.push({
        ...baseTurn(),
        model: "unknown",
        role: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        toolCalls: [],
        userMessageText: text.slice(0, TEXT_CAP),
      });
      continue;
    }

    if (type === "gemini") {
      const { inputTokens, outputTokens, cacheReadTokens } = extractTokens(m.tokens);

      const parts: string[] = [];
      if (m.thoughts && Array.isArray(m.thoughts)) {
        for (const t of m.thoughts as unknown[]) {
          if (!t || typeof t !== "object" || Array.isArray(t)) continue;
          const thought = t as Record<string, unknown>;
          const desc =
            typeof thought.description === "string" ? thought.description.trim() :
            typeof thought.subject === "string" ? thought.subject.trim() : "";
          // Only count thinking when a thought carries actual content — an empty
          // or contentless `thoughts` array shouldn't flag hasThinking.
          if (desc) {
            parts.push(desc);
            hasThinking = true;
          }
        }
      }
      const mainText = extractTextContent(m.content ?? m.displayContent);
      if (mainText) parts.push(mainText);

      const toolCalls: ToolCall[] = [];
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls as unknown[]) {
          if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
          const t = tc as Record<string, unknown>;
          const name = typeof t.name === "string" && t.name ? t.name : "tool";
          const args: Record<string, unknown> =
            t.args && typeof t.args === "object" && !Array.isArray(t.args)
              ? (t.args as Record<string, unknown>)
              : {};
          const isError = t.status === "error" ? true : undefined;
          toolCalls.push({ name, arguments: args, isError });
        }
      }

      const hasContent = parts.length > 0 || toolCalls.length > 0;
      const hasTokens = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0;
      if (!hasContent && !hasTokens) continue;

      const model = typeof m.model === "string" && m.model.trim() ? m.model : "unknown";

      turns.push({
        ...baseTurn(),
        model,
        role: "assistant",
        inputTokens,
        outputTokens,
        cacheReadTokens,
        toolCalls,
        assistantText: parts.join("\n").slice(0, TEXT_CAP) || undefined,
      });
    }
    // All other message types (info, error, warning) carry no turn data.
  }

  const cliVersion =
    typeof record.version === "string" && record.version.trim() ? record.version.trim() : null;
  return { turns, meta: { compactBoundaries: [], cliVersion, hasThinking } };
}

/** Backward-compatible turns-only parse; delegates to the WithMeta helper. */
async function parseGeminiFile(filePath: string, projectDirName: string): Promise<UsageTurn[]> {
  return (await parseGeminiFileWithMeta(filePath, projectDirName)).turns;
}

// ─── adapter ─────────────────────────────────────────────────────────────────

const geminiAdapter: SessionAdapter = {
  id: ADAPTER_ID,
  displayName: "Gemini CLI",

  async discover(): Promise<SessionFile[]> {
    const geminiHome =
      typeof process.env.GEMINI_HOME === "string" && process.env.GEMINI_HOME.trim()
        ? path.resolve(process.env.GEMINI_HOME.trim())
        : path.join(os.homedir(), ".gemini");

    const tmpDir = path.join(geminiHome, "tmp");
    const projectMap = await loadProjectMap(geminiHome);

    let projectEntries: import("fs").Dirent[];
    try {
      projectEntries = await fs.readdir(tmpDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results = await Promise.all(
      projectEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<SessionFile[]> => {
          const projName = entry.name;
          const projDir = path.join(tmpDir, projName);
          const chatsDir = path.join(projDir, "chats");

          let chatFiles: string[];
          try {
            const entries = await fs.readdir(chatsDir);
            chatFiles = entries.filter((f) => f.startsWith("session-") && f.endsWith(".json"));
          } catch {
            return [];
          }
          if (chatFiles.length === 0) return [];

          // Resolve project folder path: projects.json → .project_root → fallback to dir name
          const folderPath =
            projectMap.get(projName) ??
            (await readProjectRoot(projDir)) ??
            null;

          const projectDirName = folderPath ? encodeProjectPath(folderPath) : projName;

          return chatFiles.map((file) => ({
            source: ADAPTER_ID,
            filePath: path.join(chatsDir, file),
            projectDirName,
          }));
        })
    );

    return results.flat();
  },

  async parseFile(file: SessionFile): Promise<UsageTurn[]> {
    return parseGeminiFile(file.filePath, file.projectDirName);
  },

  async parseFileWithMeta(
    file: SessionFile
  ): Promise<{ turns: UsageTurn[]; meta: SessionTurnsMeta }> {
    // Turns are already source-stamped by `makeBaseTurn(ADAPTER_ID, …)`.
    return parseGeminiFileWithMeta(file.filePath, file.projectDirName);
  },
};

export default geminiAdapter;
