import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";
import os from "os";
import { writeFileAtomic, withFileLock } from "./atomicWrite";

// Copy-on-write history of writes performed by the template-apply layer.
// Each `recordPreWrite` snapshots the current bytes of a target file
// (if it exists) into ~/.minder/config-history/<id>/, and appends a
// manifest entry. `restore(id)` writes the snapshotted bytes back.
//
// Out of scope: directory-scope backups (bundled-skill apply rewrites
// directories, not files — backing up a tree is a separate retention
// problem and is not in TODO #56). Wave 1.2 ships per-file backups only;
// directory units pass through unwrapped and surface a "not snapshotted"
// note in the result. Future wave can extend if needed.

const HISTORY_ROOT = path.join(os.homedir(), ".minder", "config-history");
const MANIFEST_PATH = path.join(HISTORY_ROOT, "manifest.jsonl");
const LAST_PRUNE_PATH = path.join(HISTORY_ROOT, ".last-prune");
const PRUNE_INTERVAL_MS = 60 * 60_000; // 1h between auto-prunes

export type BackupId = string;

export interface HistoryEntry {
  /** Stable ID = directory name under HISTORY_ROOT. Format: <iso-ts>_<sha8>. */
  id: BackupId;
  /** When recordPreWrite ran (ISO string, also embedded in id). */
  timestamp: string;
  /** Original target path that was about to be mutated. */
  targetPath: string;
  /** SHA-256 (hex) of the snapshotted bytes. Empty string when the
   *  target didn't exist at record time (a "would-create" entry). */
  contentSha: string;
  /** True when the target didn't exist — restore() will delete the file
   *  rather than write empty bytes. */
  wasMissing: boolean;
  /** Optional caller-supplied label (e.g. "applyHook", "applyMcp"). */
  label?: string;
  /** Optional project slug so the Config History tab can scope per-project. */
  projectSlug?: string;
  /** Bytes of the snapshot, base64-encoded. Only present when wasMissing
   *  is false. Stored alongside the manifest in the snapshot file —
   *  duplicated in `list()` results would bloat memory, so the manifest
   *  itself stores only the path reference. */
  snapshotPath?: string;
}

interface ManifestRecord extends Omit<HistoryEntry, "snapshotPath"> {
  snapshotPath?: string;
}

async function ensureHistoryRoot(): Promise<void> {
  await fs.mkdir(HISTORY_ROOT, { recursive: true });
}

function makeId(timestamp: string, contentSha: string): BackupId {
  // Filesystem-safe ISO timestamp + 8-char hash prefix.
  const ts = timestamp.replace(/[:.]/g, "-");
  const shaSlice = contentSha ? contentSha.slice(0, 8) : "missing";
  return `${ts}_${shaSlice}`;
}

/**
 * Snapshot `targetPath` to history before a caller mutates it. Returns
 * the BackupId, or `null` when recording itself failed (a recording
 * failure must NEVER block the caller's apply — a missing backup is
 * unfortunate, an aborted apply is worse).
 *
 * Each call records a fresh snapshot — no dedup against the last-known
 * hash. Rapid re-apply of identical content produces multiple manifest
 * entries; the smart-retention prune drops them down to one per day
 * after 24h. Dedup-on-write is doable but not in Wave 1.2 scope.
 */
export async function recordPreWrite(
  targetPath: string,
  opts: { projectSlug?: string; label?: string } = {},
): Promise<BackupId | null> {
  try {
    return await recordPreWriteInner(targetPath, opts);
  } catch (err) {
    console.warn(
      `[configHistory] Could not snapshot ${targetPath}: ${(err as Error).message}. Apply will proceed without backup.`,
    );
    return null;
  }
}

async function recordPreWriteInner(
  targetPath: string,
  opts: { projectSlug?: string; label?: string },
): Promise<BackupId> {
  await ensureHistoryRoot();
  const resolved = path.resolve(targetPath);
  const timestamp = new Date().toISOString();

  let bytes: Buffer | null = null;
  try {
    bytes = await fs.readFile(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    // wasMissing = true — record the absence so restore() can roll back
    // a "create" by deleting the file.
  }

  const contentSha = bytes ? sha256(bytes) : "";
  const id = makeId(timestamp, contentSha);
  const snapshotPath = bytes ? path.join(HISTORY_ROOT, id, path.basename(resolved)) : undefined;

  if (bytes && snapshotPath) {
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFileAtomic(snapshotPath, bytes.toString("base64"));
  }

  const record: ManifestRecord = {
    id,
    timestamp,
    targetPath: resolved,
    contentSha,
    wasMissing: bytes === null,
    label: opts.label,
    projectSlug: opts.projectSlug,
    snapshotPath,
  };

  await appendManifest(record);
  void maybePrune();
  return id;
}

/** Restore a backup. Throws if the BackupId is unknown or the snapshot
 *  file is missing (corrupt history). The restoration itself is recorded
 *  as a fresh history entry so the user can undo a restore. */
export async function restore(id: BackupId): Promise<void> {
  const entries = await list();
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`No backup with id ${id}`);
  }

  await recordPreWrite(entry.targetPath, {
    projectSlug: entry.projectSlug,
    label: `restore→${id}`,
  });

  if (entry.wasMissing) {
    try {
      await fs.unlink(entry.targetPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    return;
  }

  if (!entry.snapshotPath) {
    throw new Error(`Backup ${id} has no snapshot path (manifest corrupt)`);
  }
  const base64 = await fs.readFile(entry.snapshotPath, "utf-8");
  const bytes = Buffer.from(base64, "base64");
  await fs.mkdir(path.dirname(entry.targetPath), { recursive: true });
  await writeFileAtomic(entry.targetPath, bytes.toString("utf-8"));
}

/** List all manifest entries, optionally filtered by project slug. Newest
 *  first. Returns empty list when the history root doesn't exist. */
export async function list(
  filter: { projectSlug?: string } = {},
): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(MANIFEST_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ManifestRecord;
      if (filter.projectSlug && parsed.projectSlug !== filter.projectSlug) continue;
      entries.push(parsed);
    } catch {
      // Skip malformed lines — a partial flush from a crashed writer
      // shouldn't poison the whole list. The rest of the manifest is
      // still parseable.
    }
  }
  entries.reverse();
  return entries;
}

/** Apply the smart-retention policy: keep every entry within 24h, one per
 *  day for 7d, one per week for 30d, drop the rest. Snapshot files
 *  belonging to dropped entries are unlinked. Manifest is rewritten in
 *  place. Safe to call frequently; cheap when nothing's due. */
export async function prune(now: number = Date.now()): Promise<{ kept: number; removed: number }> {
  const all = await list();
  if (all.length === 0) return { kept: 0, removed: 0 };

  const oneDay = 24 * 60 * 60_000;
  const oneWeek = 7 * oneDay;
  const thirtyDays = 30 * oneDay;

  // Group entries into retention buckets keyed per (targetPath, bucket-id)
  // so we keep the newest in each bucket per file. Different files don't
  // compete for the same retention slot.
  const keep = new Set<string>();
  const byFile = new Map<string, HistoryEntry[]>();
  for (const e of all) {
    const arr = byFile.get(e.targetPath) ?? [];
    arr.push(e);
    byFile.set(e.targetPath, arr);
  }
  for (const fileEntries of byFile.values()) {
    const seenBuckets = new Set<string>();
    for (const e of fileEntries) {
      const age = now - new Date(e.timestamp).getTime();
      let bucket: string;
      if (age <= oneDay) {
        bucket = `recent:${e.id}`; // every entry within 24h
      } else if (age <= oneWeek + oneDay) {
        bucket = `daily:${dayKey(e.timestamp)}`;
      } else if (age <= thirtyDays) {
        bucket = `weekly:${weekKey(e.timestamp)}`;
      } else {
        continue; // older than 30d → drop unconditionally
      }
      if (!seenBuckets.has(bucket)) {
        seenBuckets.add(bucket);
        keep.add(e.id);
      }
    }
  }

  const dropped = all.filter((e) => !keep.has(e.id));
  if (dropped.length === 0) {
    await touchLastPrune(now);
    return { kept: all.length, removed: 0 };
  }

  await withFileLock(MANIFEST_PATH, async () => {
    const kept = all.filter((e) => keep.has(e.id));
    kept.reverse(); // back to oldest-first append order
    const next = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : "");
    await writeFileAtomic(MANIFEST_PATH, next);
  });

  for (const e of dropped) {
    if (!e.snapshotPath) continue;
    try {
      await fs.rm(path.dirname(e.snapshotPath), { recursive: true, force: true });
    } catch {
      // Snapshot directory may already be gone — manifest is the source
      // of truth, missing snapshot is benign once the manifest line is
      // dropped.
    }
  }

  await touchLastPrune(now);
  return { kept: keep.size, removed: dropped.length };
}

async function appendManifest(record: ManifestRecord): Promise<void> {
  await withFileLock(MANIFEST_PATH, async () => {
    const line = JSON.stringify(record) + "\n";
    let prior = "";
    try {
      prior = await fs.readFile(MANIFEST_PATH, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await writeFileAtomic(MANIFEST_PATH, prior + line);
  });
}

async function maybePrune(): Promise<void> {
  let last: number;
  try {
    const raw = await fs.readFile(LAST_PRUNE_PATH, "utf-8");
    last = Number.parseInt(raw, 10);
    if (!Number.isFinite(last)) last = 0;
  } catch {
    last = 0;
  }
  if (Date.now() - last < PRUNE_INTERVAL_MS) return;
  try {
    await prune();
  } catch (err) {
    console.warn(`[configHistory] Prune failed: ${(err as Error).message}`);
  }
}

async function touchLastPrune(now: number): Promise<void> {
  try {
    await writeFileAtomic(LAST_PRUNE_PATH, String(now));
  } catch {
    // Best-effort — a missed touch just means the next call re-runs
    // prune sooner. Worse outcomes (write fail loops) self-throttle
    // because prune() is bounded by the manifest size.
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function weekKey(iso: string): string {
  // Lazy bucket: just the year + ISO week number derived from the date.
  // Edge cases at year boundaries don't matter for retention — the worst
  // result is keeping one extra entry near year-end.
  const d = new Date(iso);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.floor((d.getTime() - start.getTime()) / (24 * 60 * 60_000));
  const week = Math.floor(dayOfYear / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

