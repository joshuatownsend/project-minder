"use client";

import { useEffect, useState, useCallback } from "react";
import { Modal } from "@/components/ui/modal";
import type { HandoffVerbosity } from "@/lib/usage/sessionHandoffDoc";

interface HandoffDocResponse {
  doc: string;
}

interface HandoffDocModalProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

const VERBOSITIES: HandoffVerbosity[] = ["minimal", "standard", "verbose", "full"];

export function HandoffDocModal({ sessionId, open, onClose }: HandoffDocModalProps) {
  const [verbosity, setVerbosity] = useState<HandoffVerbosity>("standard");
  const [doc, setDoc] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy");

  const fetchDoc = useCallback(
    (v: HandoffVerbosity, signal: AbortSignal) => {
      setLoading(true);
      fetch(`/api/sessions/${sessionId}/handoff?verbosity=${v}`, { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<HandoffDocResponse>;
        })
        .then((d) => setDoc(d.doc))
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setDoc(`Error: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false);
        });
    },
    [sessionId]
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchDoc(verbosity, controller.signal);
    return () => controller.abort();
  }, [open, verbosity, fetchDoc]);

  const handleCopy = () => {
    navigator.clipboard.writeText(doc).then(() => {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy"), 2000);
    });
  };

  const handleDownload = () => {
    const blob = new Blob([doc], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handoff-${sessionId.slice(0, 8)}-${verbosity}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal open={open} onClose={onClose} title="Handoff Document" maxWidthClass="max-w-3xl">
      <div style={{ padding: "16px" }}>
        {/* Controls */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" }}>
          <select
            value={verbosity}
            onChange={(e) => setVerbosity(e.target.value as HandoffVerbosity)}
            style={{
              padding: "5px 10px",
              fontSize: "0.78rem",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            {VERBOSITIES.map((v) => (
              <option key={v} value={v}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>

          <div style={{ flex: 1 }} />

          <button
            onClick={handleCopy}
            disabled={loading || !doc}
            style={{
              padding: "5px 12px",
              fontSize: "0.78rem",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              cursor: loading || !doc ? "not-allowed" : "pointer",
              opacity: loading || !doc ? 0.5 : 1,
            }}
          >
            {copyLabel}
          </button>

          <button
            onClick={handleDownload}
            disabled={loading || !doc}
            style={{
              padding: "5px 12px",
              fontSize: "0.78rem",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              cursor: loading || !doc ? "not-allowed" : "pointer",
              opacity: loading || !doc ? 0.5 : 1,
            }}
          >
            Download .md
          </button>
        </div>

        {/* Preview */}
        <pre
          style={{
            margin: 0,
            padding: "14px",
            border: "1px solid var(--border)",
            borderRadius: "5px",
            background: "var(--bg-base)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            lineHeight: 1.6,
            color: loading ? "var(--text-muted)" : "var(--text-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "60vh",
            overflowY: "auto",
          }}
        >
          {loading ? "Loading…" : (doc || "No content")}
        </pre>
      </div>
    </Modal>
  );
}
