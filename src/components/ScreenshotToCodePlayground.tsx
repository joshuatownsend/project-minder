"use client";

import { useCallback, useState } from "react";
import { Camera, AlertCircle } from "lucide-react";
import { CodeBlock } from "./ui/code-block";
import { ScreenshotToCodePreview } from "./ScreenshotToCodePreview";
import {
  PROVIDERS,
  PROVIDER_DEFAULT_MODEL,
  FRAMEWORKS,
  VARIANTS,
  type Provider,
  type Framework,
  type Variant,
} from "@/mcp/screenshot-to-code/constants";

type OutputView = "code" | "preview";

const ACCEPTED_MIME = new Set<"image/png" | "image/jpeg" | "image/webp">([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

const PROVIDER_LABEL: Record<Provider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

interface SuccessResponse {
  ok: true;
  code: string;
  language: "tsx";
  provider: Provider;
  model: string;
}

interface ErrorResponse {
  ok: false;
  error: { code: string; message: string };
}

/** Read a File as a base64 data URL via FileReader (single shot, native).
 *  Returns the base64 payload only — caller can rebuild the data URL when
 *  it needs to display the preview. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const result = typeof fr.result === "string" ? fr.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
    fr.readAsDataURL(file);
  });
}

export function ScreenshotToCodePlayground() {
  const [provider, setProvider] = useState<Provider>("gemini");
  const [model, setModel] = useState<string>(PROVIDER_DEFAULT_MODEL.gemini);
  const [framework, setFramework] = useState<Framework>("react-tailwind");
  const [variant, setVariant] = useState<Variant>("minimal");

  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMediaType, setImageMediaType] = useState<ImageMediaType>("image/png");

  const [pending, setPending] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<OutputView>("code");

  const imageDataUrl = imageBase64 ? `data:${imageMediaType};base64,${imageBase64}` : null;

  const onFile = useCallback(async (file: File) => {
    if (!ACCEPTED_MIME.has(file.type as ImageMediaType)) {
      setError(`Unsupported image type "${file.type}". Use PNG, JPEG, or WebP.`);
      return;
    }
    setError(null);
    setCode(null);
    try {
      const base64 = await readFileAsBase64(file);
      setImageMediaType(file.type as ImageMediaType);
      setImageBase64(base64);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read file");
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) void onFile(file);
    },
    [onFile],
  );

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void onFile(file);
    },
    [onFile],
  );

  const onConvert = useCallback(async () => {
    if (!imageBase64) return;
    setPending(true);
    setError(null);
    setCode(null);
    try {
      const res = await fetch("/api/screenshot-to-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imageBase64,
          mediaType: imageMediaType,
          provider,
          model,
          framework,
          variant,
        }),
      });
      const json = (await res.json()) as SuccessResponse | ErrorResponse;
      if (!json.ok) {
        setError(`${json.error.code}: ${json.error.message}`);
        return;
      }
      setCode(json.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setPending(false);
    }
  }, [imageBase64, imageMediaType, provider, model, framework, variant]);

  const onProviderChange = (p: Provider) => {
    setProvider(p);
    setModel(PROVIDER_DEFAULT_MODEL[p]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Camera style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
        <h2
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
            margin: 0,
          }}
        >
          Screenshot → React
        </h2>
      </header>

      <Controls
        provider={provider}
        onProviderChange={onProviderChange}
        model={model}
        setModel={setModel}
        framework={framework}
        setFramework={setFramework}
        variant={variant}
        setVariant={setVariant}
      />

      <Dropzone
        imageDataUrl={imageDataUrl}
        onDrop={onDrop}
        onPickFile={onPickFile}
        onClear={() => {
          setImageBase64(null);
          setCode(null);
          setError(null);
        }}
      />

      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button
          type="button"
          onClick={onConvert}
          disabled={!imageBase64 || pending}
          style={{
            padding: "6px 14px",
            background: imageBase64 && !pending ? "var(--info)" : "var(--surface-2)",
            color: imageBase64 && !pending ? "var(--text-on-info, white)" : "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: "0.78rem",
            fontFamily: "var(--font-body)",
            cursor: imageBase64 && !pending ? "pointer" : "not-allowed",
          }}
        >
          {pending ? "Converting…" : "Convert"}
        </button>
        <span
          style={{
            fontSize: "0.7rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {imageBase64 ? `${Math.round((imageBase64.length * 3) / 4 / 1024)} KB` : "no image"}
        </span>
      </div>

      {error && <ErrorBanner message={error} />}
      {code !== null && (
        <OutputPanel
          code={code}
          view={view}
          onViewChange={setView}
        />
      )}
    </div>
  );
}

/** Code/Preview toggle. Both panels stay mounted (CSS visibility toggle)
 *  so switching tabs doesn't tear down the iframe and re-fetch its CDN
 *  scripts. */
function OutputPanel({
  code,
  view,
  onViewChange,
}: {
  code: string;
  view: OutputView;
  onViewChange: (v: OutputView) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <ViewToggle view={view} onChange={onViewChange} />
      <div style={{ display: view === "code" ? "block" : "none" }}>
        <CodeBlock code={code} language="tsx" filename="GeneratedComponent.tsx" />
      </div>
      <div style={{ display: view === "preview" ? "block" : "none" }}>
        <ScreenshotToCodePreview code={code} />
      </div>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: OutputView;
  onChange: (v: OutputView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Output view"
      style={{
        display: "inline-flex",
        alignSelf: "flex-start",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        padding: "2px",
        gap: "2px",
      }}
    >
      {(["code", "preview"] as const).map((v) => {
        const active = view === v;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(v)}
            style={{
              padding: "4px 12px",
              fontSize: "0.7rem",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              background: active ? "var(--surface-2)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-muted)",
              border: "1px solid",
              borderColor: active ? "var(--border)" : "transparent",
              borderRadius: "3px",
              cursor: active ? "default" : "pointer",
            }}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

function Controls(props: {
  provider: Provider;
  onProviderChange: (p: Provider) => void;
  model: string;
  setModel: (s: string) => void;
  framework: Framework;
  setFramework: (f: Framework) => void;
  variant: Variant;
  setVariant: (v: Variant) => void;
}) {
  const select: React.CSSProperties = {
    padding: "5px 8px",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    fontSize: "0.75rem",
    fontFamily: "var(--font-body)",
    color: "var(--text-secondary)",
    cursor: "pointer",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: "0.6rem",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginRight: "6px",
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
      <label>
        <span style={labelStyle}>provider</span>
        <select
          value={props.provider}
          onChange={(e) => props.onProviderChange(e.target.value as Provider)}
          style={select}
        >
          {PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {PROVIDER_LABEL[id]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span style={labelStyle}>model</span>
        <input
          type="text"
          value={props.model}
          onChange={(e) => props.setModel(e.target.value)}
          style={{ ...select, minWidth: "160px" }}
        />
      </label>
      <label>
        <span style={labelStyle}>framework</span>
        <select
          value={props.framework}
          onChange={(e) => props.setFramework(e.target.value as Framework)}
          style={select}
        >
          <option value="react-tailwind">react + tailwind</option>
          <option value="react">react (inline styles)</option>
        </select>
      </label>
      <label>
        <span style={labelStyle}>variant</span>
        <select
          value={props.variant}
          onChange={(e) => props.setVariant(e.target.value as Variant)}
          style={select}
        >
          <option value="minimal">minimal</option>
          <option value="verbose">verbose</option>
        </select>
      </label>
    </div>
  );
}

function Dropzone(props: {
  imageDataUrl: string | null;
  onDrop: (e: React.DragEvent) => void;
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}) {
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={props.onDrop}
      style={{
        position: "relative",
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius)",
        padding: "16px",
        background: "var(--bg-surface)",
        minHeight: "180px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {props.imageDataUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={props.imageDataUrl}
            alt="Screenshot preview"
            style={{ maxWidth: "100%", maxHeight: "320px", borderRadius: "var(--radius)" }}
          />
          <button
            type="button"
            onClick={props.onClear}
            style={{
              position: "absolute",
              top: "8px",
              right: "8px",
              padding: "3px 8px",
              fontSize: "0.65rem",
              fontFamily: "var(--font-mono)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "3px",
              cursor: "pointer",
              color: "var(--text-secondary)",
            }}
          >
            clear
          </button>
        </>
      ) : (
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "6px",
            cursor: "pointer",
            color: "var(--text-muted)",
            fontSize: "0.78rem",
            fontFamily: "var(--font-body)",
          }}
        >
          Drop a PNG/JPEG/WebP screenshot here, or click to choose
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={props.onPickFile}
            style={{ display: "none" }}
          />
        </label>
      )}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
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
      <span style={{ fontFamily: "var(--font-mono)" }}>{message}</span>
    </div>
  );
}

