"use client";

import { useEffect, useRef } from "react";
import { useToast } from "./ToastProvider";

const POLL_INTERVAL = 5000;

export function NotificationListener() {
  const { showToast } = useToast();
  const lastChecked = useRef(new Date().toISOString());
  const permissionRequested = useRef(false);

  useEffect(() => {
    // Request notification permission on mount
    if (!permissionRequested.current && "Notification" in window) {
      permissionRequested.current = true;
      if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }

    const interval = setInterval(async () => {
      try {
        const since = lastChecked.current;
        lastChecked.current = new Date().toISOString();

        const res = await fetch(
          `/api/manual-steps/changes?since=${encodeURIComponent(since)}`
        );
        if (!res.ok) return;

        const changes = await res.json();
        if (!Array.isArray(changes) || changes.length === 0) return;

        for (const change of changes) {
          // In-app toast
          showToast(
            `New manual step: ${change.projectName}`,
            change.title
          );

          // OS notification
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification(`Manual Step: ${change.projectName}`, {
              body: change.title,
            });
          }

          // Sound alert
          try {
            const audio = new Audio("/sounds/notification.wav");
            audio.volume = 0.3;
            audio.play().catch(() => {});
          } catch {
            // Audio not supported
          }
        }
      } catch {
        // Network error, will retry next interval
      }
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [showToast]);

  return null;
}
