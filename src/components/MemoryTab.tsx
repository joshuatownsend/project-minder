"use client";

import { useState, useEffect } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { formatDistanceToNow } from "date-fns";
import type { MemoryData, MemoryFile, MemoryType } from "@/lib/types";

const TYPE_COLOR: Record<MemoryType, { bg: string; text: string; border: string }> = {
  user:      { bg: "oklch(25% 0.06 230)",   text: "#60a5fa", border: "oklch(35% 0.1 230)" },
  feedback:  { bg: "var(--accent-bg)",       text: "var(--accent)", border: "var(--accent-border)" },
  project:   { bg: "oklch(22% 0.08 145)",   text: "#4ade80", border: "oklch(35% 0.12 145)" },
  reference: { bg: "var(--bg-elevated)",     text: "var(--text-muted)", border: "var(--border-subtle)" },
};

function TypeBadge({ type }: { type: MemoryType }) {
  const c = TYPE_COLOR[type];
  return (
    <span style={{
      display: "inline-block",
      fontFamily: "var(--font-mono)", fontSize: "0.6rem", fontWeight: 600,
      letterSpacing: "0.04em", textTransform: "uppercase",
      padding: "1px 5px", borderRadius: "3px",
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {type}
    </span>
  );
}

interface MemoryTabProps {
  slug: string;
}

export function MemoryTab({ slug }: MemoryTabProps) {
  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setSelectedFile(null);
    setFileContent(null);

    fetch(`/api/memory/${slug}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json: MemoryData | null) => { if (json) setData(json); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  async function openFile(name: string) {
    if (selectedFile === name) return;
    setSelectedFile(name);
    setFileContent(null);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/memory/${slug}?file=${encodeURIComponent(name)}`);
      if (!res.ok) return;
      const json = await res.json() as { content: string };
      setFileContent(json.content);
    } catch {
      // ignore
    } finally {
      setFileLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {[...Array(3)].map((_, i) => (
          <div key={i} style={{
            height: "48px", borderRadius: "var(--radius)",
            background: "var(--bg-surface)",
            animation: "pulse 1.5s ease-in-out infinite",
          }} />
        ))}
      </div>
    );
  }

  const isEmpty = !data?.indexMd && (!data?.files || data.files.length === 0);

  if (isEmpty) {
    return (
      <div style={{ padding: "40px 0", textAlign: "center" }}>
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0 0 6px" }}>
          No memory files yet for this project.
        </p>
        <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", margin: 0 }}>
          Claude Code will create memories in{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em", color: "var(--accent)", background: "var(--accent-bg)", padding: "1px 4px", borderRadius: "3px" }}>
            ~/.claude/projects/&lt;project&gt;/memory/
          </code>
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* MEMORY.md overview */}
      {data?.indexMd && (
        <div>
          <MemorySectionHeader label="Index (MEMORY.md)" />
          <MarkdownContent content={data.indexMd} />
        </div>
      )}

      {/* File list + viewer */}
      {data?.files && data.files.length > 0 && (
        <div>
          <MemorySectionHeader label="Memory files" />
          <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
            {/* Left: file list */}
            <div style={{
              display: "flex", flexDirection: "column", gap: "4px",
              width: "240px", flexShrink: 0,
            }}>
              {data.files.map((f) => (
                <FileRow
                  key={f.name}
                  file={f}
                  active={selectedFile === f.name}
                  onClick={() => openFile(f.name)}
                />
              ))}
            </div>

            {/* Right: viewer */}
            <div style={{
              flex: 1, minWidth: 0,
              padding: "12px 16px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              minHeight: "120px",
            }}>
              {!selectedFile && (
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0 }}>
                  Select a file to view its contents.
                </p>
              )}
              {selectedFile && fileLoading && (
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0 }}>Loading…</p>
              )}
              {selectedFile && !fileLoading && fileContent && (
                <MarkdownContent content={fileContent} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MemorySectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
      <span style={{
        fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
        textTransform: "uppercase", color: "var(--text-muted)",
        fontFamily: "var(--font-body)", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

function FileRow({ file, active, onClick }: { file: MemoryFile; active: boolean; onClick: () => void }) {
  const d = new Date(file.mtime);
  const relTime = isFinite(d.getTime()) ? formatDistanceToNow(d, { addSuffix: true }) : "";

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", flexDirection: "column", gap: "2px",
        padding: "8px 10px", textAlign: "left",
        background: active ? "var(--accent-bg)" : "var(--bg-elevated)",
        border: `1px solid ${active ? "var(--accent-border)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius)", cursor: "pointer",
        transition: "background 0.1s, border-color 0.1s",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {file.type && <TypeBadge type={file.type} />}
        <span style={{
          fontSize: "0.75rem", fontFamily: "var(--font-mono)",
          color: active ? "var(--accent)" : "var(--text-primary)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {file.name}
        </span>
      </div>
      {file.description && (
        <span style={{
          fontSize: "0.68rem", color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {file.description}
        </span>
      )}
      <span style={{ fontSize: "0.62rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
        {relTime}
      </span>
    </button>
  );
}
