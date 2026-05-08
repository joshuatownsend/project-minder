"use client";

import { useState, useEffect, useCallback } from "react";
import { usePulse } from "./PulseProvider";
import { useToast } from "./ToastProvider";
import type { TaskDecision } from "@/lib/tasks/types";
import { MessageSquare, Loader2 } from "lucide-react";

type DecisionWithTitle = TaskDecision & { task_title?: string };

export function DecisionsPanel() {
  const { snapshot } = usePulse();
  const { showToast } = useToast();
  const [decisions, setDecisions] = useState<DecisionWithTitle[]>([]);
  const [loading, setLoading] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState<number | null>(null);

  const fetchDecisions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/decisions");
      if (!res.ok) return;
      const data = (await res.json()) as { decisions: DecisionWithTitle[] };
      setDecisions(data.decisions);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch whenever decisionCount changes — PulseProvider drives the cadence.
  useEffect(() => {
    void fetchDecisions();
  }, [snapshot.decisionCount, fetchDecisions]);

  const sendAnswer = async (decision: DecisionWithTitle, answer: string) => {
    if (!answer.trim() || submitting != null) return;
    setSubmitting(decision.id);
    try {
      const res = await fetch(`/api/tasks/${decision.task_id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: decision.id, answer }),
      });
      if (res.status === 410) {
        showToast("Task already finished", "The task completed before your answer could be sent.");
        setDecisions((prev) => prev.filter((d) => d.id !== decision.id));
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDecisions((prev) => prev.filter((d) => d.id !== decision.id));
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[decision.id];
        return next;
      });
      showToast("Answer sent", answer);
    } catch (err) {
      showToast("Failed to send answer", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(null);
    }
  };

  if (decisions.length === 0) return null;

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
        <MessageSquare style={{ width: "11px", height: "11px" }} />
        Decisions waiting ({decisions.length})
        {loading && (
          <Loader2
            style={{ width: "10px", height: "10px", animation: "spin 1s linear infinite" }}
          />
        )}
      </div>

      {decisions.map((d) => {
        let choices: string[] | null = null;
        if (d.choices) {
          try {
            choices = JSON.parse(d.choices) as string[];
          } catch {
            /* ignore malformed choices */
          }
        }
        const currentAnswer = answers[d.id] ?? "";
        const isSending = submitting === d.id;

        return (
          <div
            key={d.id}
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            {d.task_title && (
              <div
                style={{
                  fontSize: "0.68rem",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {d.task_title}
              </div>
            )}
            <div style={{ fontSize: "0.85rem", color: "var(--text-primary)", lineHeight: 1.5 }}>
              {d.prompt}
            </div>

            {choices && choices.length > 0 && (
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {choices.map((c) => (
                  <button
                    key={c}
                    onClick={() => void sendAnswer(d, c)}
                    disabled={submitting != null}
                    style={{
                      padding: "4px 12px",
                      background:
                        submitting != null ? "var(--bg-elevated)" : "var(--accent)",
                      border: "none",
                      borderRadius: "4px",
                      fontSize: "0.78rem",
                      fontWeight: 500,
                      color: submitting != null ? "var(--text-muted)" : "white",
                      cursor: submitting != null ? "default" : "pointer",
                      opacity: isSending ? 0.6 : 1,
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: "6px" }}>
              <input
                type="text"
                value={currentAnswer}
                onChange={(e) =>
                  setAnswers((prev) => ({ ...prev, [d.id]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") void sendAnswer(d, currentAnswer);
                }}
                placeholder={choices ? "Or type a custom answer…" : "Type your answer…"}
                disabled={submitting != null}
                style={{
                  flex: 1,
                  padding: "5px 8px",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                  fontSize: "0.78rem",
                  color: "var(--text-primary)",
                  outline: "none",
                  fontFamily: "var(--font-body)",
                }}
              />
              <button
                onClick={() => void sendAnswer(d, currentAnswer)}
                disabled={!currentAnswer.trim() || submitting != null}
                style={{
                  padding: "5px 12px",
                  background: currentAnswer.trim() ? "var(--accent)" : "var(--bg-elevated)",
                  border: "none",
                  borderRadius: "4px",
                  fontSize: "0.78rem",
                  fontWeight: 500,
                  color: currentAnswer.trim() ? "white" : "var(--text-muted)",
                  cursor:
                    currentAnswer.trim() && submitting == null ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                {isSending ? (
                  <Loader2
                    style={{ width: "12px", height: "12px", animation: "spin 1s linear infinite" }}
                  />
                ) : (
                  "Send"
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
