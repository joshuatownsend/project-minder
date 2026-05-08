"use client";

import { useState, useEffect, useCallback } from "react";
import { usePulse } from "./PulseProvider";
import type { TaskDecision } from "@/lib/tasks/types";
import { Inbox } from "lucide-react";

type InboxEntry = TaskDecision & { task_title?: string };

export function InboxPanel() {
  const { snapshot } = usePulse();
  const [messages, setMessages] = useState<InboxEntry[]>([]);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox?limit=20");
      if (!res.ok) return;
      const data = (await res.json()) as { messages: InboxEntry[] };
      setMessages(data.messages);
    } catch {
      /* best-effort */
    }
  }, []);

  // Poll on every pulse tick — inbox updates whenever a task emits INBOX: markers.
  useEffect(() => {
    void fetchMessages();
  }, [snapshot.generatedAt, fetchMessages]);

  if (messages.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "20px" }}>
      <div
        style={{
          fontSize: "0.68rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <Inbox style={{ width: "11px", height: "11px" }} />
        Inbox ({messages.length})
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          maxHeight: "200px",
          overflowY: "auto",
        }}
      >
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "4px",
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            }}
          >
            {m.task_title && (
              <div
                style={{
                  fontSize: "0.65rem",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {m.task_title}
              </div>
            )}
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
              {m.prompt}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
