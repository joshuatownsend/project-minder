import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

import { extractPrsFromEntries } from "@/lib/usage/prExtractor";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";
import { installIsolatedState } from "./_helpers/isolatedState";

/**
 * A5 — authoritative PR linkage.
 *
 * A1 already decoded `type:"pr-link"` entries and merged them with the
 * `gh pr create` scraper. What A5 adds is **provenance**: which of the two
 * produced each link, threaded through `session_prs` and both read backends so
 * the surfaces can tell an authoritative link from a regex match on command
 * output.
 *
 * The slice was specified expecting the scraper to be retired. Measured across
 * 5,319 local transcripts it must stay: recorded entries find 738 distinct PR
 * URLs to the scraper's 657 (86 the regex never sees), but 5 URLs are found
 * ONLY by the scraper — and every one came from a session that recorded
 * `pr-link` entries for its other PRs. That is a gap in the CLI's own
 * recording, not an artifact of old transcripts, so it will not age out.
 */

function assistantBashCall(toolUseId: string, command: string): ConversationEntry {
  return {
    type: "assistant",
    timestamp: "2026-08-01T12:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
    },
  } as ConversationEntry;
}

function userToolResult(toolUseId: string, content: unknown): ConversationEntry {
  return {
    type: "user",
    timestamp: "2026-08-01T12:00:01Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  } as ConversationEntry;
}

function prLinkEntry(number: number, url: string, repo?: string): ConversationEntry {
  return {
    type: "pr-link",
    timestamp: "2026-08-01T12:00:02Z",
    prNumber: number,
    prUrl: url,
    ...(repo === undefined ? {} : { prRepository: repo }),
  } as ConversationEntry;
}

describe("A5 — PR link provenance", () => {
  it("labels a scraped link as scraped", () => {
    const prs = extractPrsFromEntries([
      assistantBashCall("t1", "gh pr create --fill"),
      userToolResult("t1", "https://github.com/foo/bar/pull/7"),
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0].source).toBe("scraped");
  });

  it("labels a recorded link as recorded", () => {
    const prs = extractPrsFromEntries([
      prLinkEntry(377, "https://github.com/owner/repo/pull/377", "owner/repo"),
    ]);
    expect(prs[0].source).toBe("recorded");
  });

  it("upgrades a link both sources saw to recorded", () => {
    // The merge already preferred the entry's `repo`; the row's provenance has
    // to follow, or a link whose fields all came from Claude Code would still
    // be labelled a regex match.
    const url = "https://github.com/foo/bar/pull/42";
    const prs = extractPrsFromEntries([
      assistantBashCall("t1", "gh pr create --fill"),
      userToolResult("t1", url),
      prLinkEntry(42, url, "canonical/repo"),
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ repo: "canonical/repo", source: "recorded" });
  });

  it("keeps a scraped link the recorded entries never mention", () => {
    // The measured case that keeps the scraper alive: a session records SOME of
    // its PRs and misses one. Deleting the scraper loses this link entirely.
    const prs = extractPrsFromEntries([
      prLinkEntry(1, "https://github.com/foo/bar/pull/1", "foo/bar"),
      assistantBashCall("t1", "gh pr create --fill"),
      userToolResult("t1", "https://github.com/foo/bar/pull/2"),
    ]);
    expect(prs.map((p) => [p.number, p.source])).toEqual([
      [1, "recorded"],
      [2, "scraped"],
    ]);
  });
});

// ── Dual-backend parity ──────────────────────────────────────────────────────

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

interface JsonlEntry {
  type: string;
  timestamp?: string;
  message?: unknown;
  [k: string]: unknown;
}

describe("A5 — source value validation", () => {
  it("treats an unrecognised DB value as unknown, not as a valid source", async () => {
    // The column is TEXT, so a hand-edited or future-typo value would otherwise
    // be cast straight through and reach the UI as an invalid PrLink.source,
    // where it renders as neither recorded nor scraped and looks like a
    // rendering bug rather than a data one (Copilot review of #385).
    const { toPrLinkSource } = await import("@/lib/types/session");
    expect(toPrLinkSource("recorded")).toBe("recorded");
    expect(toPrLinkSource("scraped")).toBe("scraped");
    for (const junk of [null, undefined, "", "RECORDED", "guessed", 1, {}]) {
      expect(toPrLinkSource(junk)).toBeUndefined();
    }
  });
});

describe.runIf(driverAvailable)("A5 — provenance survives the SQLite round trip", () => {
  // Installed INSIDE this describe, not at module scope: the pure-parsing
  // suite above needs no temp home, and scoping the hooks keeps that true.
  //
  // This block used to point MINDER_STATE_DIR at the temp home. The helper
  // deletes the variable instead, so `DB_DIR` comes from the spied
  // `os.homedir()` and lands at `<tmp>/.minder` rather than `<tmp>` — one
  // rule for all thirty files, and the one the majority already relied on.
  const state = installIsolatedState({ prefix: "pm-a5-" });

  /** Mirror of the helper's temp home, so fixture paths below read unchanged. */
  let tmpHome: string;

  const SESSION = "aaaaaaaa-4444-4444-4444-44445555a5a5";
  const PROJECT_DIR = "C--dev-a5-demo";

  beforeEach(() => {
    tmpHome = state.tmpHome();
  });

  async function writeFixture(): Promise<void> {
    const entries: JsonlEntry[] = [
      {
        type: "user",
        timestamp: "2026-08-01T12:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "open the PRs" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-08-01T12:00:01Z",
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-08-01T12:00:02Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "https://github.com/foo/bar/pull/2" },
          ],
        },
      },
      // Recorded separately — the PR the scraper never sees.
      {
        type: "pr-link",
        timestamp: "2026-08-01T12:00:03Z",
        prNumber: 1,
        prUrl: "https://github.com/foo/bar/pull/1",
        prRepository: "foo/bar",
      },
    ];
    const file = path.join(tmpHome, ".claude", "projects", PROJECT_DIR, `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  it("promotes a scraped row to recorded when the pr-link entry arrives later", async () => {
    // The P1 from the Codex review of #385, reproduced end to end. Live
    // indexing persists the scraped `gh pr create` result the moment it is
    // parsed; Claude Code appends its authoritative `pr-link` entry afterwards.
    // With INSERT OR IGNORE the upgrade was discarded, so the DB backend
    // reported the link as `scraped` forever while a file parse called it
    // `recorded` — a silent divergence on the very field that says which
    // source to trust.
    const file = path.join(tmpHome, ".claude", "projects", PROJECT_DIR, `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });

    const scrapedOnly = [
      { type: "user", timestamp: "2026-08-01T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      {
        type: "assistant",
        timestamp: "2026-08-01T12:00:01Z",
        message: {
          id: "m1", role: "assistant", model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }],
        },
      },
      {
        type: "user",
        timestamp: "2026-08-01T12:00:02Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/foo/bar/pull/9" }] },
      },
    ];
    await fs.writeFile(file, scrapedOnly.map((e) => JSON.stringify(e)).join("\n") + "\n");

    await state.reload();
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    const ingest = await import("@/lib/db/ingest");
    const opts = { projectsDir: path.join(tmpHome, ".claude", "projects") };

    await ingest.reconcileAllSessions(db!, opts);
    expect(
      (db!.prepare("SELECT source FROM session_prs WHERE pr_number = 9").get() as { source: string }).source
    ).toBe("scraped");

    // Claude Code appends its own record of the same PR.
    await fs.appendFile(
      file,
      JSON.stringify({
        type: "pr-link", timestamp: "2026-08-01T12:00:03Z",
        prNumber: 9, prUrl: "https://github.com/foo/bar/pull/9", prRepository: "canonical/repo",
      }) + "\n"
    );
    await ingest.reconcileAllSessions(db!, opts);

    const row = db!
      .prepare("SELECT source, repo FROM session_prs WHERE pr_number = 9")
      .get() as { source: string; repo: string };
    expect(row.source).toBe("recorded");
    // The recorded repository wins too — it is reported, not parsed from a URL.
    expect(row.repo).toBe("canonical/repo");
  });

  it("stores and returns each link's source, and agrees with the file backend", async () => {
    await writeFixture();
    await state.reload();

    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    expect(db).not.toBeNull();
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });

    // Assert against the table first: if the rows are missing the read-path
    // assertion below can't tell "never written" from "written and dropped on
    // read", and those need different fixes.
    const rows = db!
      .prepare("SELECT pr_number, source FROM session_prs ORDER BY pr_number")
      .all() as Array<{ pr_number: number; source: string | null }>;
    expect(rows.map((r) => [r.pr_number, r.source])).toEqual([
      [1, "recorded"],
      [2, "scraped"],
    ]);

    const { loadSessionDetailFromDb } = await import("@/lib/data/sessionDetailFromDb");
    const detail = await loadSessionDetailFromDb(db!, SESSION);
    // Explicit, because `detail?.prs ?? []` turns "loader returned null" into an
    // empty list that reads exactly like "this session has no PRs".
    expect(detail).not.toBeNull();
    const dbPrs = (detail!.prs ?? []).map((p) => [p.number, p.source]);

    // Both links present, each carrying the source that produced it.
    expect(dbPrs).toEqual([
      [1, "recorded"],
      [2, "scraped"],
    ]);

    // The file backend derives the same thing from the same transcript — the
    // parity that every A-wave slice has broken at least once.
    const raw = await fs.readFile(
      path.join(tmpHome, ".claude", "projects", PROJECT_DIR, `${SESSION}.jsonl`),
      "utf-8"
    );
    const parsed = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ConversationEntry);
    const filePrs = extractPrsFromEntries(parsed).map((p) => [p.number, p.source]);
    expect(filePrs).toEqual(dbPrs);
  });

  it("does not count an unchanged upsert as a recovered row", async () => {
    // `DO UPDATE` reports changes = 1 whenever it fires, and the old CASE form
    // fired on every conflict — writing the stored value back to itself. A
    // re-scan then counted every historical PR as newly written, and
    // recoverStraddledPrs re-scans the whole transcript whenever a tail holds
    // any orphan tool result (Codex review, #385).
    await writeFixture();
    await state.reload();
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });

    const stmt = db!.prepare(
      `INSERT INTO session_prs (session_id, pr_url, pr_number, repo, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, pr_url) DO UPDATE SET
         source = 'recorded',
         repo   = CASE WHEN excluded.repo <> '' THEN excluded.repo ELSE session_prs.repo END
       WHERE excluded.source = 'recorded'
         AND (session_prs.source IS NOT 'recorded'
              OR (excluded.repo <> '' AND session_prs.repo IS NOT excluded.repo))`
    );

    const url = "https://github.com/foo/bar/pull/77";
    // First write.
    expect(stmt.run(SESSION, url, 77, "foo/bar", "recorded").changes).toBe(1);
    // Identical replay writes nothing.
    expect(stmt.run(SESSION, url, 77, "foo/bar", "recorded").changes).toBe(0);
    // A scraped duplicate must not demote, and must not count either.
    expect(stmt.run(SESSION, url, 77, "foo/bar", "scraped").changes).toBe(0);
    expect(
      (db!.prepare("SELECT source FROM session_prs WHERE pr_number = 77").get() as { source: string })
        .source
    ).toBe("recorded");
  });

  it("schedules the re-parse that fills `source` on pre-upgrade rows", async () => {
    // Migration v22 adds the column but cannot populate it: provenance is
    // decoded from the transcript, not recoverable in SQL. The migration
    // originally claimed the rows would "re-populate on the next reconcile",
    // which is false for BOTH paths a session can take — an unchanged
    // transcript hits the no-op gate, and a growing one appends from the tail
    // and never revisits the indexed prefix. Only a DERIVED_VERSION bump
    // re-reads them (Codex review, #385).
    //
    // Pinned as a pair so a later slice cannot add a migration that needs a
    // re-parse and forget the bump — the failure is silent and permanent.
    const { DERIVED_VERSION } = await import("@/lib/db/derivationVersion");
    const { LATEST_MIGRATION_VERSION } = await import("@/lib/db/migrations");

    expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(22);
    expect(DERIVED_VERSION).toBeGreaterThanOrEqual(15);
  });
});
