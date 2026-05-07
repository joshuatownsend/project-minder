import "server-only";
import type DatabaseT from "better-sqlite3";
import { getDb } from "@/lib/db/connection";

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  failure_count: number;
}

export async function listSubscriptions(): Promise<PushSubscriptionRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC").all() as PushSubscriptionRow[];
}

export async function addSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent: string | null
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, last_seen_at, failure_count)
     VALUES (@endpoint, @p256dh, @auth, @user_agent, @now, @now, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       last_seen_at = excluded.last_seen_at,
       failure_count = 0`
  ).run({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_agent: userAgent, now });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = @endpoint").run({ endpoint });
}

export async function incrementFailure(db: DatabaseT.Database, endpoint: string): Promise<void> {
  db.prepare("UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE endpoint = @endpoint")
    .run({ endpoint });
}

export async function touchLastSeen(db: DatabaseT.Database, endpoint: string): Promise<void> {
  const now = new Date().toISOString();
  db.prepare("UPDATE push_subscriptions SET last_seen_at = @now WHERE endpoint = @endpoint")
    .run({ endpoint, now });
}

export const FAILURE_THRESHOLD = 5;
