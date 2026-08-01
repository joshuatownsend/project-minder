import "server-only";

/**
 * Notification rules engine — evaluation + dispatch.
 *
 * Called fire-and-forget from `/api/hooks`. Two invariants, both load-bearing
 * because a Claude Code session is blocked on that request:
 *
 *   1. **Never throws.** Every failure path is swallowed and logged. A broken
 *      rule must not turn into a failed hook.
 *   2. **Never awaited by the route.** Matching is synchronous and bounded;
 *      delivery (push/telegram, which cross the network) happens after the
 *      route has already responded.
 */

import type { MinderConfig } from "@/lib/types";
import type { HookEvent } from "@/lib/hooks/buffer";
import { getFlag } from "@/lib/featureFlags";
import { sendPushAll } from "@/lib/push/sender";
import { sendTelegram } from "@/lib/notifications/telegram";
import { extractFields } from "./fields";
import { matchRules } from "./matcher";
import { claimCooldown } from "./cooldown";
import { queueOsNotification } from "./osQueue";
import { DEFAULT_COOLDOWN_SEC, type RuleMatch, type RuleSeverity } from "./types";

const SEVERITY_PREFIX: Record<RuleSeverity, string> = {
  info: "",
  warn: "⚠ ",
  critical: "🔴 ",
};

/**
 * Match `event` against the configured rules and deliver anything that fires.
 *
 * `config` is passed in rather than re-read: the hook route has already loaded
 * it to check the `liveActivity` flag, and a second `readConfig()` on every
 * tool call is a filesystem read we don't need.
 */
export async function evaluateAndDispatchRules(
  config: MinderConfig,
  event: HookEvent,
  projectSlug: string,
  projectName: string,
): Promise<void> {
  try {
    if (!getFlag(config.featureFlags, "notificationRules", true)) return;

    const rules = config.notificationRules;
    if (!rules?.length) return;

    const fields = extractFields(event, projectSlug);
    const matches = matchRules(rules, fields, projectSlug);
    if (matches.length === 0) return;

    const jobs: Promise<unknown>[] = [];
    for (const match of matches) {
      const cooldownSec = match.rule.cooldownSec ?? DEFAULT_COOLDOWN_SEC;
      if (!claimCooldown(match.rule.id, projectSlug, cooldownSec)) continue;
      jobs.push(...deliver(match, projectName));
    }

    await Promise.allSettled(jobs);
  } catch (err) {
    console.warn("[rules] evaluation failed:", err);
  }
}

function deliver(match: RuleMatch, projectName: string): Promise<unknown>[] {
  const { rule, excerpt, projectSlug } = match;
  const prefix = SEVERITY_PREFIX[rule.severity ?? "info"];
  const eventKey = `rule:${rule.id}:${projectSlug}`;

  const payload = {
    title: `${prefix}${projectName} — ${rule.name}`,
    body: excerpt,
    url: `/project/${projectSlug}`,
    tag: `rule-${rule.id}-${projectSlug}`,
  };

  const jobs: Promise<unknown>[] = [];

  if (rule.channels.push) {
    jobs.push(
      sendPushAll(payload, eventKey).catch((err: unknown) => {
        console.warn(`[rules] push failed (${rule.id}):`, err);
      }),
    );
  }

  if (rule.channels.telegram) {
    jobs.push(
      sendTelegram(`${prefix}${projectName} — ${rule.name}: ${excerpt}`, eventKey).catch(
        (err: unknown) => {
          console.warn(`[rules] telegram failed (${rule.id}):`, err);
        },
      ),
    );
  }

  // `os` cannot be delivered from here — only a browser with permission can
  // raise an OS notification — so the match is queued for `/api/pulse` to hand
  // to whichever tab polls next. Queuing is not optional: `os` is the default
  // channel for a new custom rule and the only channel on two presets, so
  // dropping it here would make those rules silently do nothing.
  if (rule.channels.os) {
    queueOsNotification({
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity ?? "info",
      projectSlug,
      projectName,
      excerpt,
      at: new Date().toISOString(),
    });
  }

  return jobs;
}
