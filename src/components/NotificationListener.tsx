"use client";

import { useEffect } from "react";
import { useToast } from "./ToastProvider";
import { usePulse, type PulseChange } from "./PulseProvider";

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

  // Request OS notification permission once on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Subscribe to fresh change events from the shared pulse stream. The
  // PulseProvider owns the polling loop; we just react to the events it pushes.
  useEffect(() => {
    return subscribeChanges((changes: PulseChange[]) => {
      for (const change of changes) {
        showToast(`New manual step: ${change.projectName}`, change.title);

        if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
          new Notification(`Manual Step: ${change.projectName}`, { body: change.title });
        }

        playNotificationSound();
      }
    });
  }, [subscribeChanges, showToast]);

  return null;
}
