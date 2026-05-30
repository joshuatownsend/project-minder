import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import { parse as parseToml } from "smol-toml";
import type { SessionAdapter, SessionFile, HarnessConfig, HarnessConfigRule, HarnessResource } from "./types";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";
import { encodeProjectPath } from "@/lib/usage/projectMatch";
import { toSlug } from "@/lib/scanner/claudeConversations";
import { TEXT_CAP, makeBaseTurn } from "./utils";
import { redactConfig } from "./redact";

const ADAPTER_ID = "codex" as const;
const META_READ_CONCURRENCY = 16;
const DISPLAY_NAME = "Codex" as const;

// Per-rules-file content cap so a runaway rules file can't bloat the response.
const RULES_CONTENT_CAP = 20_000;
// Subdirs surfaced as presence flags (no content read — some, like
// archived_sessions, are large; logs_2.sqlite is ~79 MB).
const NOTABLE_RESOURCES = ["rules", "memories", "plugins", "automations", "prompts"] as const;

/** Resolve the Codex config home: `$CODEX_HOME` if set, else `~/.codex`.
 *  Shared by session discovery and the read-only config surface so both agree
 *  on a machine that overrides the home. */
function resolveCodexHome(): string {
  const env = process.env.CODEX_HOME;
  return typeof env === "string" && env.trim()
    ? path.resolve(env.trim())
    : path.join(os.homedir(), ".codex");
}

// ─── file walk ──────────────────────────────────────────────────────────────

async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(full);
    }
  }
  return results.sort();
}

// ─── session meta ───────────────────────────────────────────────────────────

interface SessionMeta {
  id: string;
  cwd: string;
}

// Reads the first line in 4KB chunks until a newline is found (max 64KB).
// Avoids loading entire session files while handling arbitrarily long session_meta lines.
async function readSessionMeta(filePath: string): Promise<SessionMeta | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await fs.open(filePath, "r");
    const CHUNK = 4096;
    const MAX = 65536;
    const buf = Buffer.allocUnsafe(CHUNK);
    const chunks: string[] = [];
    let offset = 0;
    let firstLine = "";
    while (offset < MAX) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
      if (bytesRead === 0) {
        firstLine = chunks.join("");
        break;
      }
      const chunk = buf.toString("utf-8", 0, bytesRead);
      const nl = chunk.indexOf("\n");
      if (nl >= 0) {
        firstLine = chunks.join("") + chunk.slice(0, nl);
        break;
      }
      chunks.push(chunk);
      offset += bytesRead;
    }
    const entry = safeParseJson(firstLine);
    if (!entry || entry.type !== "session_meta" || !entry.payload) return null;
    const p = entry.payload as Record<string, unknown>;
    return {
      id: typeof p.id === "string" ? p.id : path.basename(filePath, ".jsonl"),
      cwd: typeof p.cwd === "string" ? p.cwd : "",
    };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

// Runs fn over items in batches to cap concurrent open file handles
async function batchedMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return results;
}

// ─── parsing helpers ─────────────────────────────────────────────────────────

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function parseTimestamp(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  return null;
}

function extractModel(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const direct =
    (typeof v.model === "string" && v.model.trim()) ||
    (typeof v.model_name === "string" && v.model_name.trim());
  if (direct) return direct as string;
  if (v.info && typeof v.info === "object") {
    const m = extractModel(v.info);
    if (m) return m;
  }
  return null;
}

interface RawUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

function normalizeRawUsage(value: unknown): RawUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    input_tokens: n(v.input_tokens),
    cached_input_tokens: n(v.cached_input_tokens ?? v.cache_read_input_tokens),
    output_tokens: n(v.output_tokens),
  };
}

function subtractRawUsage(curr: RawUsage, prev: RawUsage | null): RawUsage {
  return {
    input_tokens: Math.max(curr.input_tokens - (prev?.input_tokens ?? 0), 0),
    cached_input_tokens: Math.max(curr.cached_input_tokens - (prev?.cached_input_tokens ?? 0), 0),
    output_tokens: Math.max(curr.output_tokens - (prev?.output_tokens ?? 0), 0),
  };
}

function convertToDeltas(raw: RawUsage): { inputTokens: number; cacheReadTokens: number; outputTokens: number } {
  const cacheReadTokens = Math.min(raw.cached_input_tokens, raw.input_tokens);
  return {
    inputTokens: Math.max(raw.input_tokens - cacheReadTokens, 0),
    cacheReadTokens,
    outputTokens: raw.output_tokens,
  };
}

function isBootstrapMessage(text: string): boolean {
  const t = text.trim();
  return t.startsWith("<user_instructions>") || t.startsWith("<environment_context>");
}

function extractUserText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.type === "input_text" && typeof item.text === "string")
    .map((item) => (item.text as string).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ─── event-stream parser ─────────────────────────────────────────────────────

interface TurnState {
  parts: string[];
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model: string | null;
}

function createTurnState(): TurnState {
  return { parts: [], toolCalls: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, model: null };
}

async function parseCodexFile(filePath: string, fallbackProjectDirName: string): Promise<UsageTurn[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const firstEntry = safeParseJson(lines[0]);
  if (!firstEntry || firstEntry.type !== "session_meta" || !firstEntry.payload) return [];
  const metaPayload = firstEntry.payload as Record<string, unknown>;

  const sessionId =
    typeof metaPayload.id === "string" ? metaPayload.id : path.basename(filePath, ".jsonl");
  const cwd = typeof metaPayload.cwd === "string" ? metaPayload.cwd : "";
  const projectDirName = cwd ? encodeProjectPath(cwd) : fallbackProjectDirName;
  const projectSlug = toSlug(projectDirName);

  // Codex has no per-turn timestamps; use session creation time, falling back to file mtime
  let sessionTimestamp: string =
    parseTimestamp(metaPayload.timestamp) ??
    (await fs.stat(filePath).then((s) => s.mtime.toISOString()).catch(() => new Date().toISOString()));

  const turns: UsageTurn[] = [];
  let currentModel: string | null =
    typeof metaPayload.model === "string" && metaPayload.model.trim() ? metaPayload.model : null;
  let previousTotals: RawUsage | null = null;
  let currentTurn: TurnState = createTurnState();

  const baseTurn = () => makeBaseTurn(ADAPTER_ID, sessionTimestamp, sessionId, projectSlug, projectDirName);

  function flushTurn() {
    const hasContent = currentTurn.parts.length > 0;
    const hasTokens = currentTurn.inputTokens > 0 || currentTurn.outputTokens > 0 || currentTurn.cacheReadTokens > 0;
    const hasTools = currentTurn.toolCalls.length > 0;
    if (!hasContent && !hasTokens && !hasTools) {
      currentTurn = createTurnState();
      return;
    }
    turns.push({
      ...baseTurn(),
      model: currentTurn.model ?? currentModel ?? "unknown",
      role: "assistant",
      inputTokens: currentTurn.inputTokens,
      outputTokens: currentTurn.outputTokens,
      cacheReadTokens: currentTurn.cacheReadTokens,
      toolCalls: currentTurn.toolCalls,
      assistantText: currentTurn.parts.join("\n").slice(0, TEXT_CAP) || undefined,
    });
    currentTurn = createTurnState();
  }

  for (let i = 1; i < lines.length; i++) {
    const entry = safeParseJson(lines[i]);
    if (!entry) continue;

    // ── turn boundary ──────────────────────────────────────────────────────
    if (entry.type === "turn_context") {
      flushTurn();
      const model = extractModel(entry.payload);
      if (model) {
        currentModel = model;
        currentTurn.model = model;
      }
      continue;
    }

    // ── conversation items ─────────────────────────────────────────────────
    if (entry.type === "response_item") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      if (payload.type === "message") {
        if (payload.role === "user") {
          const text = extractUserText(payload.content);
          if (!text || isBootstrapMessage(text)) continue;
          flushTurn();
          turns.push({
            ...baseTurn(),
            model: currentModel ?? "unknown",
            role: "user",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            toolCalls: [],
            userMessageText: text.slice(0, TEXT_CAP),
          });
        } else if (payload.role === "assistant") {
          if (Array.isArray(payload.content)) {
            for (const item of payload.content as unknown[]) {
              if (!item || typeof item !== "object" || Array.isArray(item)) continue;
              const c = item as Record<string, unknown>;
              if (c.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
                currentTurn.parts.push(c.text.trim());
              }
            }
          }
          if (!currentTurn.model && currentModel) currentTurn.model = currentModel;
        }
        continue;
      }

      // Tool calls
      const isToolCall =
        payload.type === "function_call" ||
        payload.type === "custom_tool_call" ||
        payload.type === "web_search_call";
      if (isToolCall) {
        const name =
          typeof payload.name === "string"
            ? payload.name
            : payload.type === "web_search_call"
            ? "web_search"
            : "tool";
        let args: Record<string, unknown> = {};
        if (payload.type === "function_call" && typeof payload.arguments === "string") {
          try {
            args = JSON.parse(payload.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
        }
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        currentTurn.toolCalls.push({ name, arguments: args, id: callId });
        continue;
      }
    }

    // ── token counts ───────────────────────────────────────────────────────
    if (entry.type === "event_msg") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "token_count") continue;

      const tokenInfo = (payload.info ?? {}) as Record<string, unknown>;
      const lastUsage = normalizeRawUsage(tokenInfo.last_token_usage);
      const totalUsage = normalizeRawUsage(tokenInfo.total_token_usage);

      let rawUsage = lastUsage;
      if (!rawUsage && totalUsage) rawUsage = subtractRawUsage(totalUsage, previousTotals);
      if (totalUsage) previousTotals = totalUsage;
      if (!rawUsage) continue;

      const { inputTokens, outputTokens, cacheReadTokens } = convertToDeltas(rawUsage);
      if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) continue;

      currentTurn.inputTokens += inputTokens;
      currentTurn.outputTokens += outputTokens;
      currentTurn.cacheReadTokens += cacheReadTokens;

      const model = extractModel(tokenInfo) ?? extractModel(payload);
      if (model) {
        currentModel = model;
        currentTurn.model = model;
      } else if (!currentTurn.model && currentModel) {
        currentTurn.model = currentModel;
      }
    }
  }

  flushTurn();

  return turns;
}

// ─── read-only config surface (item 1) ───────────────────────────────────────

/** Read `<home>/config.toml`, parse it, and redact secrets from the parsed
 *  object. Returns `{ config }` on success, `{ parseError }` if the file
 *  exists but won't parse, and `{ config: null }` if it's simply absent. Never
 *  throws. */
async function readCodexConfigToml(
  home: string
): Promise<{ config: unknown | null; parseError?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(home, "config.toml"), "utf-8");
  } catch {
    return { config: null }; // absent (or unreadable) — not an error
  }
  try {
    return { config: redactConfig(parseToml(raw)) };
  } catch {
    // Deliberately generic: the parser's error message echoes the offending
    // source line, which could itself contain a secret — surfacing it raw
    // would bypass object-redaction. The user has the file to debug syntax.
    return { config: null, parseError: "config.toml could not be parsed (not valid TOML)." };
  }
}

/** Read instruction/rules files under `<home>/rules` (`*.rules` / `*.md`),
 *  capping each file's content. Rules are user-authored prose (like CLAUDE.md),
 *  shown as-is. Returns [] when the dir is missing. */
async function readCodexRules(home: string): Promise<HarnessConfigRule[]> {
  const dir = path.join(home, "rules");
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && /\.(rules|md|txt)$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const rules: HarnessConfigRule[] = [];
  for (const name of files) {
    try {
      const content = await fs.readFile(path.join(dir, name), "utf-8");
      rules.push({
        name,
        content: content.slice(0, RULES_CONTENT_CAP),
        truncated: content.length > RULES_CONTENT_CAP,
      });
    } catch {
      // Skip an unreadable rules file rather than failing the whole surface.
    }
  }
  return rules;
}

/** Presence-only check of notable subdirs — no content read. */
async function checkCodexResources(home: string): Promise<HarnessResource[]> {
  return Promise.all(
    NOTABLE_RESOURCES.map(async (name) => {
      let present = false;
      try {
        present = (await fs.stat(path.join(home, name))).isDirectory();
      } catch {
        present = false;
      }
      return { name, present };
    })
  );
}

// ─── adapter ─────────────────────────────────────────────────────────────────

const codexAdapter: SessionAdapter = {
  id: ADAPTER_ID,
  displayName: DISPLAY_NAME,

  async discover(): Promise<SessionFile[]> {
    const codexHome = resolveCodexHome();

    const searchDirs = [
      path.join(codexHome, "sessions"),
      path.join(codexHome, "archived_sessions"),
    ];

    // Walk both dirs in parallel; sessions/ takes priority over archived/ for dedup
    const [sessionFiles, archivedFiles] = await Promise.all(searchDirs.map(walkJsonlFiles));
    const allFiles = [...sessionFiles, ...archivedFiles];

    // Read metadata in bounded batches to avoid hitting the FD limit (EMFILE)
    const metas = await batchedMap(allFiles, readSessionMeta, META_READ_CONCURRENCY);

    const seen = new Set<string>();
    const files: SessionFile[] = [];
    for (let i = 0; i < allFiles.length; i++) {
      const meta = metas[i];
      if (!meta || seen.has(meta.id)) continue;
      seen.add(meta.id);
      const projectDirName = meta.cwd
        ? encodeProjectPath(meta.cwd)
        : path.basename(allFiles[i], ".jsonl");
      files.push({ source: ADAPTER_ID, filePath: allFiles[i], projectDirName });
    }

    return files;
  },

  async parseFile(file: SessionFile): Promise<UsageTurn[]> {
    return parseCodexFile(file.filePath, file.projectDirName);
  },

  async readConfig(): Promise<HarnessConfig> {
    const home = resolveCodexHome();
    const base = { harnessId: ADAPTER_ID, displayName: DISPLAY_NAME, home };

    let present = false;
    try {
      present = (await fs.stat(home)).isDirectory();
    } catch {
      present = false;
    }
    if (!present) {
      return { ...base, present: false, config: null, rules: [], resources: [] };
    }

    // Read config.toml, rules, and resource presence concurrently — all
    // degrade-silent, none touch the large session/log files or auth.json.
    const [tomlResult, rules, resources] = await Promise.all([
      readCodexConfigToml(home),
      readCodexRules(home),
      checkCodexResources(home),
    ]);

    return {
      ...base,
      present: true,
      config: tomlResult.config,
      parseError: tomlResult.parseError,
      rules,
      resources,
    };
  },
};

export default codexAdapter;
