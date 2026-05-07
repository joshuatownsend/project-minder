import "server-only";
import crypto from "crypto";
import { getDb } from "@/lib/db/connection";

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function payloadHash(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Returns true if the notification should be sent (not a duplicate within the
 * dedup window). Inserts a log row immediately to claim the slot — acts as a
 * lightweight optimistic lock against concurrent callers.
 */
export async function shouldSend(
  channel: "push" | "telegram" | "os",
  eventKey: string,
  payload: unknown
): Promise<boolean> {
  const db = await getDb();
  if (!db) return true; // can't check — allow send

  const hash = payloadHash(payload);
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();

  const existing = db
    .prepare(
      `SELECT id FROM notification_log
       WHERE channel = @channel AND event_key = @event_key AND payload_hash = @hash
         AND sent_at >= @window_start
       LIMIT 1`
    )
    .get({ channel, event_key: eventKey, hash, window_start: windowStart });

  if (existing) return false;

  // Claim the slot by inserting a deduped row.
  db.prepare(
    `INSERT INTO notification_log (channel, event_key, payload_hash, sent_at, status)
     VALUES (@channel, @event_key, @hash, @sent_at, 'deduped')`
  ).run({ channel, event_key: eventKey, hash, sent_at: new Date().toISOString() });

  return true;
}

export async function logNotification(
  channel: "push" | "telegram" | "os",
  eventKey: string,
  payload: unknown,
  status: "sent" | "failed",
  error?: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const hash = payloadHash(payload);
  db.prepare(
    `INSERT INTO notification_log (channel, event_key, payload_hash, sent_at, status, error)
     VALUES (@channel, @event_key, @hash, @sent_at, @status, @error)`
  ).run({ channel, event_key: eventKey, hash, sent_at: new Date().toISOString(), status, error: error ?? null });
}
