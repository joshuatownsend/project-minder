"use client";

import { useState } from "react";
import { usePulse } from "./PulseProvider";
import { useToast } from "./ToastProvider";
import { Zap, Play } from "lucide-react";

interface EmergencyStopResult {
  stopped: true;
  processesKilled: number;
  interactiveSpared: number;
  errors: string[];
}

export function EmergencyStopButton() {
  const { snapshot } = usePulse();
  const { showToast } = useToast();
  const [pending, setPending] = useState(false);

  const handleStop = async () => {
    const ok = window.confirm(
      "This will kill all dispatcher-managed Claude Code processes. " +
        "Interactive sessions you started yourself will be spared. Continue?"
    );
    if (!ok) return;
    setPending(true);
    try {
      const res = await fetch("/api/tasks/emergency-stop", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as EmergencyStopResult;
      showToast(
        "Dispatcher stopped",
        `${data.processesKilled} killed, ${data.interactiveSpared} interactive spared`
      );
    } catch (err) {
      showToast("Stop failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setPending(false);
    }
  };

  const handleResume = async () => {
    setPending(true);
    try {
      const res = await fetch("/api/tasks/emergency-stop/resume", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast("Dispatcher resumed", "The dispatcher will pick up pending tasks on the next tick.");
    } catch (err) {
      showToast("Resume failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setPending(false);
    }
  };

  if (snapshot.dispatcherPaused) {
    return (
      <button
        onClick={() => void handleResume()}
        disabled={pending}
        title="Resume dispatcher"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "4px 10px",
          background: "color-mix(in srgb, var(--success, #22c55e) 15%, transparent)",
          border: "1px solid color-mix(in srgb, var(--success, #22c55e) 30%, transparent)",
          borderRadius: "4px",
          fontSize: "0.72rem",
          fontWeight: 600,
          color: "var(--success, #22c55e)",
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.6 : 1,
          lineHeight: 1,
        }}
      >
        <Play style={{ width: "10px", height: "10px" }} />
        Resume
      </button>
    );
  }

  return (
    <button
      onClick={() => void handleStop()}
      disabled={pending}
      title="Emergency stop — kill all dispatcher-managed Claude sessions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "4px 10px",
        background: "color-mix(in srgb, var(--error) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--error) 25%, transparent)",
        borderRadius: "4px",
        fontSize: "0.72rem",
        fontWeight: 600,
        color: "var(--error)",
        cursor: pending ? "default" : "pointer",
        opacity: pending ? 0.6 : 1,
        lineHeight: 1,
      }}
    >
      <Zap style={{ width: "10px", height: "10px" }} />
      Stop
    </button>
  );
}
