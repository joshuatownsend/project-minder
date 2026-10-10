import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import type { UsageTurn } from "@/lib/usage/types";
import type { SessionFile } from "@/lib/adapters/types";
import type { MinderConfig } from "@/lib/types";

// #637: `sessions.session_id` is the row's whole identity, so two files carrying the same id (the same
// transcript under two Claude homes, or a copied .jsonl) used to overwrite each other on every sweep.
// The file indexed first now keeps the id until it disappears.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-ingest-idcollision-", preserveEnv: ["MINDER_USE_DB"] });
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function setup() {
  await state.reload();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  const init = await mig.initDb();
  expect(init.error).toBeNull();
  return { conn, ingest, db: (await conn.getDb())!, projectsDir: path.join(tmpHome, ".claude", "projects") };
}

async function writeSession(filePath: string, prompt: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = [
    { type: "user", timestamp: "2026-04-30T10:00:00Z", message: { content: [{ type: "text", text: prompt }] } },
    {
      type: "assistant",
      timestamp: "2026-04-30T10:00:01Z",
      message: {
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ];
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe.skipIf(!driverAvailable)("session id held by two files (#637)", () => {
  it("keeps the file indexed first instead of replacing it with the other", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = path.join(projectsDir, "C--dev-alpha", "same-id.jsonl");
    const b = path.join(projectsDir, "C--dev-beta", "same-id.jsonl");
    await writeSession(a, "alpha prompt");
    await writeSession(b, "beta prompt");

    expect((await ingest.reconcileSessionFile(db, a, "C--dev-alpha")).rowsWritten).toBeGreaterThan(0);
    expect((await ingest.reconcileSessionFile(db, b, "C--dev-beta")).rowsWritten).toBe(0);
    // A forced re-derive does not hand the id to the other file either.
    expect((await ingest.reconcileSessionFile(db, b, "C--dev-beta", { force: true })).rowsWritten).toBe(0);

    const row = db
      .prepare("SELECT file_path, project_dir_name, initial_prompt FROM sessions WHERE session_id = 'same-id'")
      .get() as { file_path: string; project_dir_name: string; initial_prompt: string };
    expect(row).toEqual({ file_path: a, project_dir_name: "C--dev-alpha", initial_prompt: "alpha prompt" });

    // One warning per colliding pair, not one per sweep.
    await ingest.reconcileSessionFile(db, b, "C--dev-beta");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("same-id"))).toHaveLength(1);
    conn.closeDb();
  });

  it("lets only one of two concurrent reconciles write a shared new id", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = path.join(projectsDir, "C--dev-alpha", "same-id.jsonl");
    const b = path.join(projectsDir, "C--dev-beta", "same-id.jsonl");
    await writeSession(a, "alpha prompt");
    await writeSession(b, "beta prompt");

    // Both look before either writes, as the watcher does for two new paths.
    const results = await Promise.all([
      ingest.reconcileSessionFile(db, a, "C--dev-alpha"),
      ingest.reconcileSessionFile(db, b, "C--dev-beta"),
    ]);
    expect(results.filter((r) => r.rowsWritten > 0)).toHaveLength(1);
    const row = db.prepare("SELECT file_path, initial_prompt FROM sessions WHERE session_id = 'same-id'").get() as {
      file_path: string;
      initial_prompt: string;
    };
    expect(row.initial_prompt).toBe(row.file_path === a ? "alpha prompt" : "beta prompt");
    conn.closeDb();
  });

  it("does not rewrite the row on every sweep while both files exist", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeSession(path.join(projectsDir, "C--dev-alpha", "same-id.jsonl"), "alpha prompt");
    await writeSession(path.join(projectsDir, "C--dev-beta", "same-id.jsonl"), "beta prompt");

    await ingest.reconcileAllSessions(db, { projectsDir });
    const owner = (db.prepare("SELECT file_path FROM sessions WHERE session_id = 'same-id'").get() as { file_path: string })
      .file_path;
    const second = await ingest.reconcileAllSessions(db, { projectsDir });
    expect(second.rowsWritten).toBe(0);
    expect(
      (db.prepare("SELECT file_path FROM sessions WHERE session_id = 'same-id'").get() as { file_path: string }).file_path,
    ).toBe(owner);
    conn.closeDb();
  });

  it("hands the id to the other file as soon as the indexed one is gone", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = path.join(projectsDir, "C--dev-alpha", "same-id.jsonl");
    const b = path.join(projectsDir, "C--dev-beta", "same-id.jsonl");
    await writeSession(a, "alpha prompt");
    await writeSession(b, "beta prompt");
    await ingest.reconcileSessionFile(db, a, "C--dev-alpha");

    await fs.rm(a);
    await ingest.reconcileAllSessions(db, { projectsDir });
    const row = db.prepare("SELECT file_path, initial_prompt FROM sessions WHERE session_id = 'same-id'").get();
    expect(row).toEqual({ file_path: b, initial_prompt: "beta prompt" });
    conn.closeDb();
  });

  it("keeps a Claude session when an adapter session resolves to the same id", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeSession(path.join(projectsDir, "C--dev-alpha", "same-id.jsonl"), "alpha prompt");
    const codexFile = path.join(tmpHome, ".codex", "sessions", "rollout-1.jsonl");
    await fs.mkdir(path.dirname(codexFile), { recursive: true });
    await fs.writeFile(codexFile, "x"); // parsing is stubbed below
    const turn = (role: "user" | "assistant", ts: string): UsageTurn => ({
      timestamp: ts, sessionId: "same-id", projectSlug: "codexproj", projectDirName: "codexproj",
      model: role === "assistant" ? "gpt-5" : "", role, inputTokens: 10, outputTokens: 5,
      cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [],
    });
    const config: MinderConfig = { statuses: {}, hidden: [], portOverrides: {}, devRoot: tmpHome, enabledAdapters: ["claude", "codex"] };
    const opts = {
      projectsDir,
      config,
      adapterSessions: [{ source: "codex", filePath: codexFile, projectDirName: "codexproj" }] as SessionFile[],
      parseAdapterFile: vi.fn(async () => [turn("user", "2026-05-01T10:00:00Z"), turn("assistant", "2026-05-01T10:00:01Z")]),
    };

    await ingest.reconcileAllSessions(db, opts);
    await ingest.reconcileAllSessions(db, opts);
    const row = db.prepare("SELECT source, initial_prompt FROM sessions WHERE session_id = 'same-id'").get();
    expect(row).toEqual({ source: "claude", initial_prompt: "alpha prompt" });
    // The losing file is not re-parsed while it and the owner are unchanged.
    expect(opts.parseAdapterFile).toHaveBeenCalledTimes(1);
    conn.closeDb();
  });

  it("drops an adapter file's old row when its new id is refused", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeSession(path.join(projectsDir, "C--dev-alpha", "same-id.jsonl"), "alpha prompt");
    const codexFile = path.join(tmpHome, ".codex", "sessions", "rollout-1.jsonl");
    await fs.mkdir(path.dirname(codexFile), { recursive: true });
    await fs.writeFile(codexFile, "x");
    let id = "old-id";
    const turn = (role: "user" | "assistant", ts: string): UsageTurn => ({
      timestamp: ts, sessionId: id, projectSlug: "codexproj", projectDirName: "codexproj",
      model: role === "assistant" ? "gpt-5" : "", role, inputTokens: 10, outputTokens: 5,
      cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [],
    });
    const config: MinderConfig = { statuses: {}, hidden: [], portOverrides: {}, devRoot: tmpHome, enabledAdapters: ["claude", "codex"] };
    const opts = {
      projectsDir,
      config,
      adapterSessions: [{ source: "codex", filePath: codexFile, projectDirName: "codexproj" }] as SessionFile[],
      parseAdapterFile: async () => [turn("user", "2026-05-01T10:00:00Z"), turn("assistant", "2026-05-01T10:00:01Z")],
    };
    await ingest.reconcileAllSessions(db, opts);
    expect(db.prepare("SELECT file_path FROM sessions WHERE session_id = 'old-id'").get()).toEqual({ file_path: codexFile });

    // The file now resolves to an id another file holds.
    id = "same-id";
    await fs.writeFile(codexFile, "xy");
    // Counted as a change, so the sweep re-derives continuation links that pointed at the old id.
    expect((await ingest.reconcileAllSessions(db, opts)).filesChanged).toBe(1);
    expect(db.prepare("SELECT 1 FROM sessions WHERE session_id = 'old-id'").get()).toBeUndefined();
    expect(db.prepare("SELECT source FROM sessions WHERE session_id = 'same-id'").get()).toEqual({ source: "claude" });
    conn.closeDb();
  });

  it("treats a path that differs only by separators (and, on Windows, case) as the same file", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    const a = path.join(projectsDir, "C--dev-alpha", "same-id.jsonl");
    await writeSession(a, "alpha prompt");
    await ingest.reconcileSessionFile(db, a, "C--dev-alpha");
    db.prepare("UPDATE sessions SET file_path = ?, file_mtime_ms = 0 WHERE session_id = 'same-id'").run(a.replace(/[\\/]/g, "/"));
    expect((await ingest.reconcileSessionFile(db, a, "C--dev-alpha")).rowsWritten).toBeGreaterThan(0);
    conn.closeDb();
  });
});
