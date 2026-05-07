import "server-only";
import webpush from "web-push";
import { getDb } from "@/lib/db/connection";
import { getOrCreateVapidKeys } from "./vapid";
import {
  listSubscriptions,
  removeSubscription,
  incrementFailure,
  touchLastSeen,
  FAILURE_THRESHOLD,
} from "./store";
import { logNotification } from "./dedup";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface SendSummary {
  sent: number;
  failed: number;
  removed: number;
}

let vapidConfigured = false;

async function ensureVapidConfigured(): Promise<void> {
  if (vapidConfigured) return;
  const keys = await getOrCreateVapidKeys();
  webpush.setVapidDetails(
    "mailto:noreply@project-minder.local",
    keys.publicKey,
    keys.privateKey
  );
  vapidConfigured = true;
}

export async function sendPushAll(
  payload: PushPayload,
  eventKey: string
): Promise<SendSummary> {
  await ensureVapidConfigured();
  const subs = await listSubscriptions();
  const db = await getDb();
  if (!db || subs.length === 0) return { sent: 0, failed: 0, removed: 0 };

  const summary: SendSummary = { sent: 0, failed: 0, removed: 0 };
  const payloadStr = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr
        );
        await touchLastSeen(db, sub.endpoint);
        await logNotification("push", eventKey, payload, "sent");
        summary.sent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) {
          // Subscription is gone — remove it.
          await removeSubscription(sub.endpoint);
          summary.removed++;
        } else {
          await incrementFailure(db, sub.endpoint);
          if (sub.failure_count + 1 >= FAILURE_THRESHOLD) {
            await removeSubscription(sub.endpoint);
            summary.removed++;
          } else {
            summary.failed++;
          }
        }
        await logNotification("push", eventKey, payload, "failed", String(err));
      }
    })
  );

  return summary;
}
