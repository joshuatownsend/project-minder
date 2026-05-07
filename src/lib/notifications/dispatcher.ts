import "server-only";
import { readConfig } from "@/lib/config";
import { sendPushAll } from "@/lib/push/sender";
import { sendTelegram } from "@/lib/notifications/telegram";

interface ManualStepChange {
  slug: string;
  projectName: string;
  title: string;
}

export async function dispatchManualStepAdded(change: ManualStepChange): Promise<void> {
  let prefs: Record<string, boolean> | undefined;
  try {
    const config = await readConfig();
    prefs = config.notificationPrefs?.events?.["manual-step-added"] as Record<string, boolean> | undefined;
  } catch {
    return;
  }

  if (!prefs) return;

  const eventKey = `manual-step-added:${change.slug}:${Date.now()}`;
  const payload = {
    title: "New manual step",
    body: `${change.projectName}: ${change.title}`,
    url: "/manual-steps",
    tag: `manual-step-added:${change.slug}`,
  };

  const jobs: Promise<void>[] = [];

  if (prefs["push"]) {
    jobs.push(
      sendPushAll(payload, eventKey).then(() => {}).catch((err: unknown) => {
        console.warn("[dispatcher] push failed:", err);
      })
    );
  }

  if (prefs["telegram"]) {
    jobs.push(
      sendTelegram(
        `New manual step — ${change.projectName}: ${change.title}`,
        eventKey
      ).then(() => {}).catch((err: unknown) => {
        console.warn("[dispatcher] telegram failed:", err);
      })
    );
  }

  // os channel is browser-side — NotificationListener handles it via polling

  await Promise.allSettled(jobs);
}
