"use client";

import { useEffect, useState } from "react";
import type { MinderConfig } from "@/lib/types";
import {
  registerServiceWorker,
  requestPushPermission,
  subscribeToPush,
  unsubscribeFromPush,
  getCurrentPushSubscription,
} from "@/lib/clientPush";
import { S } from "./styles";
import { Toggle } from "./Toggle";
import { NotificationRulesEditor } from "./NotificationRulesEditor";

interface PushSub {
  id: number;
  endpoint: string;
  user_agent: string | null;
  last_seen_at: string;
  failure_count: number;
}

type Channel = "push" | "telegram" | "os";
type EventPrefs = NonNullable<NonNullable<MinderConfig["notificationPrefs"]>["events"]["manual-step-added"]>;

export function NotificationsSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [subscriptions, setSubscriptions] = useState<PushSub[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const prefs = config?.notificationPrefs?.events?.["manual-step-added"] ?? {};

  useEffect(() => {
    if ("Notification" in window) setPermission(Notification.permission);
    getCurrentPushSubscription().then((s) => setIsSubscribed(!!s));
    loadSubscriptions();
  }, []);

  function loadSubscriptions() {
    setSubsLoading(true);
    fetch("/api/notifications/push/subscriptions")
      .then((r) => r.json())
      .then((d) => setSubscriptions(d.subscriptions ?? []))
      .catch(() => {})
      .finally(() => setSubsLoading(false));
  }

  async function handleRequestPermission() {
    const perm = await requestPushPermission();
    setPermission(perm);
  }

  async function handleSubscribe() {
    setActionBusy(true);
    try {
      await registerServiceWorker();
      await subscribeToPush();
      setIsSubscribed(true);
      loadSubscriptions();
    } catch (e) {
      setTestMsg(`Subscribe failed: ${String(e)}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleUnsubscribe() {
    setActionBusy(true);
    try {
      await unsubscribeFromPush();
      setIsSubscribed(false);
      loadSubscriptions();
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRevoke(endpoint: string) {
    await fetch("/api/notifications/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    loadSubscriptions();
  }

  async function handleTestPush() {
    setActionBusy(true);
    setTestMsg(null);
    try {
      const res = await fetch("/api/notifications/push/test", { method: "POST" });
      const d = await res.json();
      setTestMsg(res.ok ? `Sent to ${d.sent} subscription(s).` : `Error: ${d.error ?? res.statusText}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleTestTelegram() {
    setActionBusy(true);
    setTestMsg(null);
    try {
      const res = await fetch("/api/notifications/telegram/test", { method: "POST" });
      const d = await res.json();
      setTestMsg(res.ok ? "Telegram test sent." : `Error: ${d.error ?? res.statusText}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function toggleChannel(channel: Channel, next: boolean) {
    const current = config?.notificationPrefs?.events?.["manual-step-added"] ?? {};
    const updated: EventPrefs = { ...current, [channel]: next };
    await onConfigChange({
      // Spread the sibling events back in: PUT /api/config replaces
      // `notificationPrefs` wholesale rather than merging, so sending only this
      // one key silently wiped the awaiting-permission channels.
      notificationPrefs: {
        events: {
          ...(config?.notificationPrefs?.events ?? {}),
          "manual-step-added": updated,
        },
      },
    });
  }

  const awaitingPrefs = config?.notificationPrefs?.events?.["awaiting-permission"] ?? {};

  async function toggleAwaitingChannel(channel: Channel, next: boolean) {
    const current = config?.notificationPrefs?.events?.["awaiting-permission"] ?? {};
    await onConfigChange({
      notificationPrefs: {
        events: {
          ...(config?.notificationPrefs?.events ?? {}),
          "awaiting-permission": { ...current, [channel]: next },
        },
      },
    });
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Notifications</h2>
      <p style={S.desc}>
        Browser, push, and Telegram event toggles. Grant permission first, then subscribe for push notifications.
      </p>

      {/* Permission card */}
      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <div style={S.label}>Browser notification permission</div>
            <div style={S.muted}>
              {permission === "granted"
                ? "Granted — OS notifications work."
                : permission === "denied"
                ? "Denied — change in browser site settings."
                : "Not yet granted."}
            </div>
          </div>
          {permission !== "granted" && permission !== "denied" && (
            <button style={S.btn} onClick={handleRequestPermission}>
              Enable browser notifications
            </button>
          )}
          {permission === "granted" && (
            <span style={{ ...S.badge, color: "var(--success, #4ade80)", borderColor: "var(--success, #4ade80)" }}>
              granted
            </span>
          )}
        </div>
      </div>

      {/* Push subscription card */}
      <div style={S.card}>
        <div style={{ marginBottom: "12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={S.label}>Push notifications</div>
            <div style={S.muted}>Subscribe this browser to receive pushes even when the tab is closed.</div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            {!isSubscribed ? (
              <button style={S.btn} onClick={handleSubscribe} disabled={actionBusy || permission !== "granted"}>
                Subscribe this browser
              </button>
            ) : (
              <button style={{ ...S.btn, color: "var(--error, #f87171)" }} onClick={handleUnsubscribe} disabled={actionBusy}>
                Unsubscribe
              </button>
            )}
            <button style={S.btn} onClick={handleTestPush} disabled={actionBusy}>
              Send test push
            </button>
          </div>
        </div>
        {subscriptions.length > 0 && (
          <ul style={{ listStyle: "none", margin: "8px 0 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
            {subscriptions.map((sub) => (
              <li key={sub.id} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {sub.user_agent?.split(" ").slice(0, 3).join(" ") ?? "Browser"} — last seen {new Date(sub.last_seen_at).toLocaleDateString()}
                </span>
                <button
                  style={{ ...S.btn, fontSize: "0.7rem", padding: "2px 8px", color: "var(--text-muted)" }}
                  onClick={() => handleRevoke(sub.endpoint)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {subsLoading && (
          // While the fetch is out this section rendered NOTHING, which reads
          // as "no subscriptions" rather than "not known yet" — and left the
          // state invisible to `[data-loading]`, so a capture could shoot the
          // tab mid-fetch and call it settled (Codex, PR #517).
          <div
            data-loading="true"
            style={{ fontSize: "0.74rem", color: "var(--text-muted)", marginTop: "4px" }}
          >
            Loading subscriptions…
          </div>
        )}
        {!subsLoading && subscriptions.length === 0 && (
          <div style={{ fontSize: "0.74rem", color: "var(--text-muted)", marginTop: "4px" }}>No subscriptions registered.</div>
        )}
      </div>

      {/* Event toggles */}
      <div style={{ marginBottom: "8px", fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>
        Event toggles
      </div>

      {/* Live event: manual-step-added */}
      <div style={{ ...S.row, marginBottom: "8px" }}>
        <div style={{ flex: 1 }}>
          <div style={S.label}>New manual step</div>
          <div style={S.muted}>Fires when Claude appends a new step to MANUAL_STEPS.md.</div>
          <div style={{ display: "flex", gap: "16px", marginTop: "8px" }}>
            {(["push", "telegram", "os"] as Channel[]).map((ch) => (
              <label key={ch} style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                <Toggle
                  value={!!(prefs as Record<string, boolean | undefined>)[ch]}
                  onChange={(v) => toggleChannel(ch, v)}
                  label={`${ch} for manual-step-added`}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{ch}</span>
              </label>
            ))}
            <button style={{ ...S.btn, marginLeft: "auto" }} onClick={handleTestTelegram} disabled={actionBusy}>
              Send test Telegram
            </button>
          </div>
        </div>
      </div>

      {/* Live event: awaiting-permission */}
      <div style={{ ...S.row, marginBottom: "8px" }}>
        <div style={{ flex: 1 }}>
          <div style={S.label}>Awaiting permission</div>
          <div style={S.muted}>
            Fires when a session needs your approval or input (requires the hook server).
          </div>
          <div style={{ display: "flex", gap: "16px", marginTop: "8px" }}>
            {(["push", "telegram", "os"] as Channel[]).map((ch) => (
              <label key={ch} style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                <Toggle
                  value={!!(awaitingPrefs as Record<string, boolean | undefined>)[ch]}
                  onChange={(v) => toggleAwaitingChannel(ch, v)}
                  label={`${ch} for awaiting-permission`}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{ch}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Open-ended rules engine */}
      <NotificationRulesEditor config={config} onConfigChange={onConfigChange} />

      {testMsg && (
        <div style={{ marginTop: "12px", fontSize: "0.78rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
          {testMsg}
        </div>
      )}
    </section>
  );
}
