import "server-only";
import { readConfig } from "@/lib/config";
import { sendPushAll } from "@/lib/push/sender";
import { sendTelegram } from "@/lib/notifications/telegram";

interface AwaitingPermissionOpts {
  slug: string;
  projectName: string;
  message?: string;
}

export async function dispatchAwaitingPermission(opts: AwaitingPermissionOpts): Promise<void> {
  let prefs: Record<string, boolean> | undefined;
  try {
    const config = await readConfig();
    prefs = config.notificationPrefs?.events?.["awaiting-permission"] as
      | Record<string, boolean>
      | undefined;
  } catch {
    return;
  }

  if (!prefs) return;

  // Coarse 8-second bucket key — coalesces a burst of permission notifications
  // from the same project into one push/telegram delivery per ~8s window.
  const bucket = Math.floor(Date.now() / 8_000);
  const eventKey = `awaiting-permission:${opts.slug}:${bucket}`;

  const payload = {
    title: `${opts.projectName} — awaiting permission`,
    body: opts.message ?? "Claude Code is asking for input or approval.",
    url: `/project/${opts.slug}`,
    tag: `awaiting-permission-${opts.slug}`,
  };

  const jobs: Promise<unknown>[] = [];

  if (prefs["push"]) {
    jobs.push(
      sendPushAll(payload, eventKey).catch((err: unknown) => {
        console.warn("[dispatcher] push failed (awaiting-permission):", err);
      }),
    );
  }

  if (prefs["telegram"]) {
    jobs.push(
      sendTelegram(
        `${opts.projectName} — awaiting permission: ${opts.message ?? "Claude Code needs input."}`,
        eventKey,
      ).catch((err: unknown) => {
        console.warn("[dispatcher] telegram failed (awaiting-permission):", err);
      }),
    );
  }

  // os channel handled browser-side via subscribeChanges in NotificationListener

  await Promise.allSettled(jobs);
}
