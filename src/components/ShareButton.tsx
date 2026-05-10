"use client";

import { useState } from "react";
import { Share2, Download, X, ExternalLink } from "lucide-react";
import type { Period } from "@/lib/usage/constants";
import { VALID_PERIODS } from "@/lib/usage/constants";

interface ShareButtonProps {
  period: string;
  project?: string;
  source?: string;
}

export function ShareButton({ period, project, source }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [previewPeriod, setPreviewPeriod] = useState<Period>(
    (VALID_PERIODS.map((p) => p.value) as string[]).includes(period)
      ? (period as Period)
      : "30d",
  );

  const svgUrl = buildUrl({ period: previewPeriod, theme, project, source });

  function handleDownload() {
    const a = document.createElement("a");
    a.href = svgUrl;
    a.download = `project-minder-${previewPeriod}-${theme}.svg`;
    a.click();
  }

  function handleCopyUrl() {
    const absolute = `${window.location.origin}${svgUrl}`;
    navigator.clipboard.writeText(absolute).catch(() => {});
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Share stats image"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "5px 10px",
          fontSize: "0.68rem",
          fontFamily: "var(--font-body)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-muted)",
          background: "transparent",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          cursor: "pointer",
          lineHeight: 1,
          transition: "color 0.1s, border-color 0.1s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
          (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
          (e.currentTarget as HTMLElement).style.borderColor = "var(--border-subtle)";
        }}
      >
        <Share2 style={{ width: "10px", height: "10px" }} />
        Share
      </button>

      {open && (
        <ShareModal
          svgUrl={svgUrl}
          theme={theme}
          setTheme={setTheme}
          previewPeriod={previewPeriod}
          setPreviewPeriod={setPreviewPeriod}
          onDownload={handleDownload}
          onCopyUrl={handleCopyUrl}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareModal({
  svgUrl,
  theme,
  setTheme,
  previewPeriod,
  setPreviewPeriod,
  onDownload,
  onCopyUrl,
  onClose,
}: {
  svgUrl: string;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  previewPeriod: Period;
  setPreviewPeriod: (p: Period) => void;
  onDownload: () => void;
  onCopyUrl: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    onCopyUrl();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-default)",
          borderRadius: "10px",
          padding: "20px",
          width: "min(90vw, 820px)",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Share2 style={{ width: "13px", height: "13px", color: "var(--text-muted)" }} />
          <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>
            Share stats image
          </span>
          <a
            href="/help/share"
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "0.68rem", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: "3px", textDecoration: "none", marginRight: "8px" }}
          >
            <ExternalLink style={{ width: "9px", height: "9px" }} />
            Help
          </a>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "2px" }}
          >
            <X style={{ width: "14px", height: "14px" }} />
          </button>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          {/* Period */}
          <div style={{ display: "flex", gap: "0", background: "var(--bg-elevated)", borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
            {VALID_PERIODS.map((p, i) => (
              <button
                key={p.value}
                onClick={() => setPreviewPeriod(p.value)}
                style={{
                  padding: "4px 9px",
                  fontSize: "0.7rem",
                  fontFamily: "var(--font-body)",
                  color: previewPeriod === p.value ? "var(--text-primary)" : "var(--text-muted)",
                  background: previewPeriod === p.value ? "var(--bg-overlay)" : "transparent",
                  border: "none",
                  borderRight: i < VALID_PERIODS.length - 1 ? "1px solid var(--border-subtle)" : "none",
                  cursor: "pointer",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Theme */}
          <div style={{ display: "flex", gap: "0", background: "var(--bg-elevated)", borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
            {(["dark", "light"] as const).map((t, i) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                style={{
                  padding: "4px 9px",
                  fontSize: "0.7rem",
                  fontFamily: "var(--font-body)",
                  color: theme === t ? "var(--text-primary)" : "var(--text-muted)",
                  background: theme === t ? "var(--bg-overlay)" : "transparent",
                  border: "none",
                  borderRight: i === 0 ? "1px solid var(--border-subtle)" : "none",
                  cursor: "pointer",
                }}
              >
                {t}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          <button
            onClick={handleCopy}
            style={{
              padding: "5px 10px",
              fontSize: "0.7rem",
              fontFamily: "var(--font-body)",
              color: copied ? "var(--status-active-text)" : "var(--text-secondary)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
            }}
          >
            {copied ? "Copied!" : "Copy URL"}
          </button>

          <button
            onClick={onDownload}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "5px 10px",
              fontSize: "0.7rem",
              fontFamily: "var(--font-body)",
              color: "var(--bg-base)",
              background: "var(--accent)",
              border: "none",
              borderRadius: "var(--radius)",
              cursor: "pointer",
            }}
          >
            <Download style={{ width: "11px", height: "11px" }} />
            Download SVG
          </button>
        </div>

        {/* SVG Preview */}
        <div
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "6px",
            overflow: "hidden",
            lineHeight: 0,
          }}
        >
          <img
            src={svgUrl}
            alt="Stats share image preview"
            style={{ width: "100%", display: "block" }}
          />
        </div>
      </div>
    </div>
  );
}

function buildUrl({
  period,
  theme,
  project,
  source,
}: {
  period: Period;
  theme: "dark" | "light";
  project?: string;
  source?: string;
}): string {
  const params = new URLSearchParams({ period, theme });
  if (project) params.set("project", project);
  if (source) params.set("source", source);
  return `/api/share?${params}`;
}
