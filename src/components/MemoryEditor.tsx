"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { lineDiff } from "@/lib/usage/diff";
import type { MemoryFileEntry } from "@/lib/types";

interface FileResponse {
  id: string;
  absPath: string;
  scope: string;
  projectSlug?: string;
  content: string;
  mtimeMs: number;
  sizeBytes: number;
}

interface SaveResponse {
  ok: boolean;
  mtimeMs: number;
  sizeBytes: number;
  backupId?: string | null;
}

interface DiffResponse {
  snapshot: { content: string | null; timestamp: string } | null;
}

type EditorMode = "view" | "edit" | "diff";

const DIFF_MAX_LINES = 3000;

const DIFF_MARKER: Record<"added" | "removed" | "context", string> = {
  added: "+",
  removed: "-",
  context: " ",
};

function diffLineStyle(kind: "added" | "removed" | "context"): React.CSSProperties {
  if (kind === "added") return { padding: "0 6px", background: "rgba(76, 222, 128, 0.08)", color: "#86efac" };
  if (kind === "removed") return { padding: "0 6px", background: "rgba(248, 113, 113, 0.08)", color: "#fca5a5" };
  return { padding: "0 6px", color: "var(--text-secondary)" };
}

interface MemoryEditorProps {
  entry: MemoryFileEntry;
  onSaved?: () => void;
}

export function MemoryEditor({ entry, onSaved }: MemoryEditorProps) {
  const [data, setData] = useState<FileResponse | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [mode, setMode] = useState<EditorMode>("view");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [conflict, setConflict] = useState(false);
  const saveCtrl = useRef<AbortController | null>(null);

  async function loadFile(signal?: AbortSignal): Promise<FileResponse> {
    const r = await fetch(`/api/memory/by-id/${encodeURIComponent(entry.id)}`, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as FileResponse;
  }

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null);
    setError(null);
    setMode("view");
    setConflict(false);
    loadFile(ctrl.signal)
      .then((res) => {
        setData(res);
        setDraft(res.content);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setError(e.message);
      });
    return () => {
      ctrl.abort();
      saveCtrl.current?.abort();
    };
  }, [entry.id]);

  async function handleSave() {
    if (!data) return;
    saveCtrl.current?.abort();
    const ctrl = new AbortController();
    saveCtrl.current = ctrl;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/memory/by-id/${encodeURIComponent(entry.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, mtimeMs: data.mtimeMs }),
        signal: ctrl.signal,
      });
      const body: { ok?: boolean; mtimeMs?: number; sizeBytes?: number; error?: { code: string; message?: string } } =
        await res.json().catch(() => ({}));
      if (res.status === 409) {
        setConflict(true);
        return;
      }
      if (!res.ok || !body.ok) {
        const code = body.error?.code ?? `HTTP ${res.status}`;
        throw new Error(body.error?.message ?? code);
      }
      const saved = body as SaveResponse;
      setData({ ...data, content: draft, mtimeMs: saved.mtimeMs, sizeBytes: saved.sizeBytes });
      setMode("view");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved?.();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      if (saveCtrl.current === ctrl) saveCtrl.current = null;
      setSaving(false);
    }
  }

  async function handleReload() {
    setConflict(false);
    setError(null);
    try {
      const res = await loadFile();
      setData(res);
      setDraft(res.content);
      setMode("view");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reload failed");
    }
  }

  if (error && !data) {
    return <p style={{ ...errorTextStyle, padding: "20px 0" }}>{error}</p>;
  }
  if (!data) {
    return <p style={{ ...mutedStyle, padding: "20px 0" }}>Loading</p>;
  }

  const dirty = draft !== data.content;

  return (
    <div style={paneStyle}>
      <div style={toolbarStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {entry.displayName}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data.absPath}
          </span>
        </div>
        {mode === "view" && (
          <>
            <button onClick={() => setMode("edit")} style={btnStyle}>Edit</button>
            <button onClick={() => setMode("diff")} style={btnStyle} title="Compare against last config-history snapshot">Diff</button>
          </>
        )}
        {mode === "diff" && (
          <button onClick={() => setMode(dirty ? "edit" : "view")} style={btnStyle}>Close diff</button>
        )}
        {mode === "edit" && (
          <>
            <button onClick={() => setMode("diff")} style={btnStyle} title="Compare draft against last config-history snapshot">Diff</button>
            <button
              onClick={() => { setDraft(data.content); setMode("view"); setError(null); }}
              style={btnStyle}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              style={{ ...btnStyle, color: "var(--text-primary)", borderColor: "var(--border-default)" }}
              disabled={saving || !dirty}
            >
              {saving ? "Saving" : "Save"}
            </button>
          </>
        )}
        {savedFlash && (
          <span style={{ fontSize: "0.68rem", color: "var(--status-active-text, var(--accent))" }}>Saved</span>
        )}
      </div>

      {conflict && (
        <div style={conflictBannerStyle}>
          <span style={{ flex: 1 }}>File changed externally. Reload to see latest content.</span>
          <button onClick={handleReload} style={btnStyle}>Reload</button>
        </div>
      )}

      {error && <p style={errorTextStyle}>{error}</p>}

      {mode === "diff" && <DiffView entry={entry} draftContent={draft} />}
      {mode === "edit" && (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={saving}
          style={textareaStyle}
        />
      )}
      {mode === "view" && <MarkdownContent content={data.content} />}

      <div style={footerStyle}>
        <span>{(data.sizeBytes / 1024).toFixed(1)} KB</span>
        <span style={{ flex: 1 }} />
        <span>mtime {new Date(data.mtimeMs).toLocaleString()}</span>
      </div>
    </div>
  );
}

function DiffView({ entry, draftContent }: { entry: MemoryFileEntry; draftContent: string }) {
  const [snapshot, setSnapshot] = useState<DiffResponse["snapshot"]>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`/api/memory/by-id/${encodeURIComponent(entry.id)}/snapshot`, { signal: ctrl.signal })
      .then(async (r) => (r.ok ? ((await r.json()) as DiffResponse) : { snapshot: null }))
      .then((res) => setSnapshot(res.snapshot))
      .catch((e: Error) => {
        if (e.name !== "AbortError") setSnapshot(null);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [entry.id]);

  const diffLines = useMemo(
    () => (snapshot?.content != null ? lineDiff(snapshot.content, draftContent, DIFF_MAX_LINES) : []),
    [snapshot, draftContent],
  );

  if (loading) return <p style={mutedStyle}>Loading snapshot</p>;
  if (!snapshot || snapshot.content === null) {
    return (
      <p style={{ ...mutedStyle, padding: "12px 0" }}>
        No prior config-history snapshot for this file. The next save will record one.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
        snapshot {new Date(snapshot.timestamp).toLocaleString()}
      </span>
      <pre style={diffPreStyle}>
        {diffLines.map((line, i) => (
          <div key={i} style={diffLineStyle(line.kind)}>
            <span style={{ display: "inline-block", width: "1.2em" }}>{DIFF_MARKER[line.kind]}</span>
            {line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

const paneStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "12px 16px",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  minHeight: "240px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  paddingBottom: "8px",
  borderBottom: "1px solid var(--border-subtle)",
};

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: "0.7rem",
  fontFamily: "var(--font-body)",
  color: "var(--text-secondary)",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "60vh",
  padding: "10px 12px",
  fontFamily: "var(--font-mono)",
  fontSize: "0.78rem",
  color: "var(--text-primary)",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius)",
  resize: "vertical",
};

const conflictBannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "8px 12px",
  fontSize: "0.72rem",
  color: "var(--text-primary)",
  background: "var(--accent-bg)",
  border: "1px solid var(--accent-border)",
  borderRadius: "var(--radius)",
};

const errorTextStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--status-error-text, var(--accent))",
  margin: 0,
};

const mutedStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-muted)",
  margin: 0,
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  paddingTop: "8px",
  borderTop: "1px solid var(--border-subtle)",
  fontSize: "0.65rem",
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const diffPreStyle: React.CSSProperties = {
  margin: 0,
  padding: "8px 0",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.74rem",
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: "65vh",
  overflow: "auto",
};
