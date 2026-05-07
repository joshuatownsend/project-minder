"use client";

import { useEffect, useRef } from "react";
import { useToast } from "./ToastProvider";
import { usePulse, type PulseChange } from "./PulseProvider";
import type { MinderConfig } from "@/lib/types";

// Module-level singleton — reused across every notification so we don't
// leak a fresh HTMLAudioElement (and its associated network handle + media
// session entry) on each alert. Lazily created on first use to stay SSR-safe.
let notificationAudio: HTMLAudioElement | null = null;
function playNotificationSound() {
  if (typeof window === "undefined") return;
  try {
    if (!notificationAudio) {
      notificationAudio = new Audio("/sounds/notification.wav");
      notificationAudio.volume = 0.3;
    }
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(() => {});
  } catch {
    // Audio not supported
  }
}

export function NotificationListener() {
  const { showToast } = useToast();
  const { subscribeChanges } = usePulse();
  const prefsRef = useRef<MinderConfig["notificationPrefs"]>(undefined);

  // Load notification prefs (no permission prompt — that's in Settings → Notifications)
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: MinderConfig) => { prefsRef.current = d.notificationPrefs; })
      .catch(() => {});
  }, []);

  // Subscribe to fresh change events from the shared pulse stream. The
  // PulseProvider owns the polling loop; we just react to the events it pushes.
  useEffect(() => {
    return subscribeChanges((changes: PulseChange[]) => {
      for (const change of changes) {
        if (change.kind === "awaiting-permission") {
          showToast(`${change.projectName} — awaiting permission`, change.title);

          const osEnabled = prefsRef.current?.events?.["awaiting-permission"]?.os;
          if (osEnabled && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(`${change.projectName} — awaiting permission`, {
              body: change.title,
              tag: `awaiting-permission:${change.slug}`,
            });
          }

          playNotificationSound();
        } else {
          showToast(`New manual step: ${change.projectName}`, change.title);

          const osEnabled = prefsRef.current?.events?.["manual-step-added"]?.os;
          if (osEnabled && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification(`Manual Step: ${change.projectName}`, {
              body: change.title,
              tag: `manual-step-added:${change.slug}`,
            });
          }

          playNotificationSound();
        }
      }
    });
  }, [subscribeChanges, showToast]);

  return null;
}
