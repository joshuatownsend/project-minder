"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { buildPreviewSrcDoc } from "@/lib/previewIframe";

interface Props {
  /** TSX source produced by the convert call. Empty string ⇒ placeholder. */
  code: string;
  /** Pixel height of the iframe. Defaults to 480; consumers can grow it
   *  for a screenshot of a tall component. */
  height?: number;
}

/** Live-renders the LLM-generated TSX inside a sandboxed iframe.
 *
 *  Compilation (Babel) and styling (Tailwind v4) both run inside the
 *  iframe — see `buildPreviewSrcDoc` for the harness HTML and the
 *  rationale (parent bundle stays flat, opaque-origin sandbox). The
 *  parent only listens for `postMessage` errors from the harness's
 *  global error handlers so it can surface compile/runtime failures in
 *  the host UI. */
export function ScreenshotToCodePreview({ code, height = 480 }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Rebuilding the HTML on every render would tear down the iframe and
  // re-download all four CDN scripts. Memoize on `code` so unrelated
  // state changes (provider, model, etc.) don't bounce the preview.
  const srcDoc = useMemo(() => (code ? buildPreviewSrcDoc(code) : null), [code]);

  // Listen for compile + runtime errors from inside the iframe.
  //
  // Why match by source reference: a sandboxed iframe without
  // `allow-same-origin` has an opaque origin, so every message it sends
  // arrives with `event.origin === "null"`. Reference-equality against
  // the iframe's `contentWindow` is the only correct filter — origin
  // matching would either let unrelated `null`-origin messages through
  // or reject our own.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { kind?: string; message?: string };
      if (data?.kind === "preview-error") {
        setPreviewError(data.message ?? "Unknown preview error");
      } else if (data?.kind === "preview-ready") {
        setPreviewError(null);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Reset the captured error whenever new code arrives — old errors from
  // the previous render shouldn't persist past a successful convert.
  useEffect(() => {
    setPreviewError(null);
  }, [code]);

  if (!srcDoc) {
    return (
      <div
        style={{
          minHeight: `${height}px`,
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--bg-surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          fontSize: "0.78rem",
          fontFamily: "var(--font-body)",
        }}
      >
        Run Convert to generate code, then preview it here.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div
        style={{
          position: "relative",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "white",
          overflow: "hidden",
        }}
      >
        <iframe
          ref={iframeRef}
          title="Generated component preview"
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          style={{
            width: "100%",
            height: `${height}px`,
            border: 0,
            display: "block",
            background: "white",
          }}
        />
        <PreviewWatermark />
      </div>

      {previewError && <PreviewErrorBanner message={previewError} />}

      <p
        style={{
          fontSize: "0.65rem",
          color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
          margin: 0,
        }}
      >
        Preview compiles with Babel + Tailwind v4 from CDN inside a sandboxed iframe.
        React 18 UMD is used for compatibility — visual rendering is unchanged from React 19.
      </p>
    </div>
  );
}

function PreviewWatermark() {
  return (
    <span
      style={{
        position: "absolute",
        top: "6px",
        right: "8px",
        padding: "2px 6px",
        fontSize: "0.55rem",
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "rgba(0,0,0,0.45)",
        background: "rgba(255,255,255,0.6)",
        border: "1px solid rgba(0,0,0,0.1)",
        borderRadius: "3px",
        pointerEvents: "none",
      }}
    >
      preview
    </span>
  );
}

function PreviewErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        gap: "8px",
        alignItems: "flex-start",
        padding: "8px 12px",
        background: "var(--error-bg, #2a0000)",
        borderRadius: "var(--radius)",
        fontSize: "0.78rem",
        color: "var(--error, #f87171)",
      }}
    >
      <AlertCircle style={{ width: "14px", height: "14px", flex: "0 0 14px", marginTop: "2px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.04em" }}>
          PREVIEW ERROR
        </span>
        <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>{message}</span>
      </div>
    </div>
  );
}
