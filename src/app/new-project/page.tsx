"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Check, ChevronRight } from "lucide-react";
import type { LibraryResponse, LibraryIndexItem } from "@/app/api/library/route";
import type { NewProjectRequest, NewProjectResponse } from "@/app/api/projects/new/route";

type Stack = "typescript" | "python" | "go" | "rust";

const STACKS: Array<{ id: Stack; label: string; ext: string }> = [
  { id: "typescript", label: "TypeScript", ext: "ts/tsx" },
  { id: "python",     label: "Python",     ext: ".py"    },
  { id: "go",         label: "Go",         ext: ".go"    },
  { id: "rust",       label: "Rust",       ext: ".rs"    },
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Step indicators ────────────────────────────────────────────────────────────
function StepBar({ current }: { current: number }) {
  const steps = ["Details", "Stack", "Items", "Confirm"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "28px" }}>
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <div key={n} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <div style={{
              width: 22, height: 22, borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.65rem", fontFamily: "var(--font-mono)", fontWeight: 700,
              background: done ? "#22c55e" : active ? "var(--accent)" : "var(--bg-elevated)",
              color: done || active ? "var(--bg-surface)" : "var(--text-muted)",
              border: done || active ? "none" : "1px solid var(--border-subtle)",
              flexShrink: 0,
            }}>
              {done ? <Check style={{ width: 11, height: 11 }} /> : n}
            </div>
            <span style={{
              fontSize: "0.72rem", fontFamily: "var(--font-body)",
              color: active ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: active ? 600 : 400,
            }}>
              {label}
            </span>
            {i < steps.length - 1 && (
              <ChevronRight style={{ width: 10, height: 10, color: "var(--border-subtle)" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Project details ────────────────────────────────────────────────────
function Step1({
  name, setName, relPath, setRelPath, onNext,
}: {
  name: string; setName: (v: string) => void;
  relPath: string; setRelPath: (v: string) => void;
  onNext: () => void;
}) {
  const autoPath = slugify(name);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <h2 style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-body)", margin: 0 }}>
        Project details
      </h2>

      <label style={labelStyle}>
        <span style={labelText}>Display name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!relPath || relPath === slugify(name)) setRelPath(slugify(e.target.value));
          }}
          placeholder="My New Project"
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        <span style={labelText}>Folder name <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(relative to devRoot)</span></span>
        <input
          value={relPath || autoPath}
          onChange={(e) => setRelPath(e.target.value)}
          placeholder={autoPath || "my-new-project"}
          style={inputStyle}
        />
        <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Directory will be created at: devRoot/{relPath || autoPath || "…"}
        </span>
      </label>

      <footer style={footerStyle}>
        <button
          onClick={onNext}
          disabled={!name.trim() || !(relPath || autoPath).trim()}
          style={primaryBtn}
        >
          Next →
        </button>
      </footer>
    </div>
  );
}

// ── Step 2: Stack selector ─────────────────────────────────────────────────────
function Step2({
  stack, setStack, onBack, onNext,
}: {
  stack: Stack | null; setStack: (s: Stack) => void;
  onBack: () => void; onNext: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <h2 style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-body)", margin: 0 }}>
        Primary language / stack
      </h2>
      <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", fontFamily: "var(--font-body)", margin: 0 }}>
        We&apos;ll pre-select relevant library items. You can adjust the selection in the next step.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
        {STACKS.map((s) => (
          <button
            key={s.id}
            onClick={() => setStack(s.id)}
            style={{
              padding: "14px 16px", borderRadius: "var(--radius)", cursor: "pointer",
              border: stack === s.id ? "2px solid var(--accent)" : "1px solid var(--border-subtle)",
              background: stack === s.id ? "rgba(var(--accent-rgb,234,179,8),0.08)" : "var(--bg-elevated)",
              textAlign: "left",
            }}
          >
            <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-body)" }}>
              {s.label}
            </div>
            <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              {s.ext}
            </div>
          </button>
        ))}
      </div>

      <footer style={footerStyle}>
        <button onClick={onBack} style={secondaryBtn}>← Back</button>
        <button onClick={onNext} disabled={!stack} style={primaryBtn}>Next →</button>
      </footer>
    </div>
  );
}

// ── Step 3: Item selection ─────────────────────────────────────────────────────
function Step3({
  library, selectedIds, toggleId, onBack, onNext,
}: {
  library: LibraryIndexItem[] | null;
  selectedIds: Set<string>;
  toggleId: (id: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const KIND_LABEL: Record<string, string> = { command: "Command", skill: "Skill", agent: "Agent" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h2 style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-body)", margin: "0 0 4px" }}>
          Select library items
        </h2>
        <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", fontFamily: "var(--font-body)", margin: 0 }}>
          {selectedIds.size} item{selectedIds.size !== 1 ? "s" : ""} selected · these will be applied to your new project.
        </p>
      </div>

      {!library && (
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>Loading…</p>
      )}

      {library && (
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", overflow: "hidden", maxHeight: "340px", overflowY: "auto" }}>
          {library.map((item) => {
            const checked = selectedIds.has(item.id);
            return (
              <button
                key={item.id}
                onClick={() => toggleId(item.id)}
                role="checkbox"
                aria-checked={checked}
                style={{
                  display: "flex", alignItems: "center", gap: "10px",
                  padding: "9px 14px", cursor: "pointer",
                  borderBottom: "1px solid var(--border-subtle)",
                  background: checked ? "rgba(var(--accent-rgb,234,179,8),0.06)" : "transparent",
                  border: "none", width: "100%", textAlign: "left",
                }}
              >
                <div style={{
                  width: 16, height: 16, borderRadius: "3px", flexShrink: 0,
                  border: checked ? "none" : "1px solid var(--border-subtle)",
                  background: checked ? "var(--accent)" : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {checked && <Check style={{ width: 10, height: 10, color: "var(--bg-surface)" }} />}
                </div>
                <span style={{
                  fontSize: "0.62rem", fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)", minWidth: "52px", flexShrink: 0,
                }}>
                  {KIND_LABEL[item.kind] ?? item.kind}
                </span>
                <span style={{ fontSize: "0.8rem", fontFamily: "var(--font-body)", color: "var(--text-primary)", flex: 1 }}>
                  {item.name}
                </span>
                <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-body)", color: "var(--text-secondary)", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.description}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <footer style={footerStyle}>
        <button onClick={onBack} style={secondaryBtn}>← Back</button>
        <button onClick={onNext} style={primaryBtn}>
          Next →
        </button>
      </footer>
    </div>
  );
}

// ── Step 4: Confirm + create ───────────────────────────────────────────────────
function Step4({
  name, relPath, stack, selectedIds,
  submitting, result,
  onBack, onSubmit,
}: {
  name: string; relPath: string; stack: Stack | null;
  selectedIds: Set<string>;
  submitting: boolean;
  result: NewProjectResponse | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const successCount = result?.appliedItems?.filter((a) => a.result.ok).length ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <h2 style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-body)", margin: 0 }}>
        Confirm
      </h2>

      {!result && (
        <>
          <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <Row label="Name"   value={name} />
            <Row label="Folder" value={relPath} />
            {stack && <Row label="Stack" value={STACKS.find((s) => s.id === stack)?.label ?? stack} />}
            <Row label="Library items" value={selectedIds.size > 0 ? `${selectedIds.size} selected` : "None"} />
          </div>
          <footer style={footerStyle}>
            <button onClick={onBack} style={secondaryBtn} disabled={submitting}>← Back</button>
            <button onClick={onSubmit} style={primaryBtn} disabled={submitting}>
              {submitting ? "Creating…" : "Create project"}
            </button>
          </footer>
        </>
      )}

      {result && !result.ok && (
        <div style={{ padding: "14px 16px", background: "rgba(212,95,69,0.1)", borderRadius: "var(--radius)", border: "1px solid rgba(212,95,69,0.3)" }}>
          <p style={{ fontSize: "0.8rem", color: "#d45f45", fontFamily: "var(--font-body)", margin: 0 }}>
            {result.error?.message ?? "Unknown error"}
          </p>
          <footer style={{ ...footerStyle, marginTop: "12px" }}>
            <button onClick={onBack} style={secondaryBtn}>← Back</button>
          </footer>
        </div>
      )}

      {result && result.ok && (
        <div style={{ padding: "14px 16px", background: "rgba(34,197,94,0.08)", borderRadius: "var(--radius)", border: "1px solid rgba(34,197,94,0.2)" }}>
          <p style={{ fontSize: "0.85rem", color: "#22c55e", fontFamily: "var(--font-body)", margin: "0 0 4px", fontWeight: 600 }}>
            Project created
          </p>
          <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", margin: 0 }}>
            {result.projectPath}
          </p>
          {successCount > 0 && (
            <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontFamily: "var(--font-body)", margin: "6px 0 0" }}>
              {successCount} library item{successCount !== 1 ? "s" : ""} applied
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: "12px", alignItems: "baseline" }}>
      <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-body)", color: "var(--text-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ fontSize: "0.8rem", fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{value}</span>
    </div>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────────
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "5px" };
const labelText: React.CSSProperties = { fontSize: "0.72rem", fontFamily: "var(--font-body)", color: "var(--text-secondary)", fontWeight: 500 };
const inputStyle: React.CSSProperties = {
  fontSize: "0.8rem", fontFamily: "var(--font-body)", color: "var(--text-primary)",
  background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)", padding: "7px 10px", outline: "none",
};
const footerStyle: React.CSSProperties = { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" };
const primaryBtn: React.CSSProperties = {
  fontSize: "0.8rem", fontFamily: "var(--font-body)", fontWeight: 600,
  padding: "7px 18px", borderRadius: "var(--radius)", cursor: "pointer",
  background: "var(--accent)", color: "var(--bg-surface)", border: "none",
};
const secondaryBtn: React.CSSProperties = {
  fontSize: "0.8rem", fontFamily: "var(--font-body)",
  padding: "7px 14px", borderRadius: "var(--radius)", cursor: "pointer",
  background: "transparent", color: "var(--text-secondary)",
  border: "1px solid var(--border-subtle)",
};

// ── Wizard root ────────────────────────────────────────────────────────────────
export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [relPath, setRelPath] = useState("");
  const [stack, setStack] = useState<Stack | null>(null);
  const [library, setLibrary] = useState<LibraryIndexItem[] | null>(null);
  const [stackPresets, setStackPresets] = useState<Record<string, string[]>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<NewProjectResponse | null>(null);

  // Effect 1: fetch library once when reaching step 3
  useEffect(() => {
    if (step !== 3) return;
    if (library) return;
    fetch("/api/library")
      .then((r) => r.json() as Promise<LibraryResponse>)
      .then((data) => {
        setLibrary(data.items);
        setStackPresets(data.stackPresets);
      })
      .catch(() => {});
  }, [step, library]);

  // Effect 2: recompute preset whenever stack or library changes (on step 3)
  useEffect(() => {
    if (step !== 3 || !library || !stack) return;
    const preset = stackPresets[stack] ?? stackPresets.generic ?? [];
    setSelectedIds(new Set(preset));
  }, [step, stack, library, stackPresets]);

  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    setSubmitting(true);
    const resolvedPath = relPath || slugify(name);
    try {
      const body: NewProjectRequest = {
        name,
        relPath: resolvedPath,
        gitInit: true,
        libraryIds: [...selectedIds],
      };
      const res = await fetch("/api/projects/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as NewProjectResponse;
      setResult(data);
      if (data.ok) {
        setTimeout(() => router.push("/"), 2000);
      }
    } catch (e) {
      setResult({ ok: false, error: { code: "NETWORK_ERROR", message: e instanceof Error ? e.message : "Network error" } });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="shell-content" style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* Page header */}
      <header style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "28px" }}>
        <BookOpen style={{ width: 14, height: 14, color: "var(--text-muted)" }} />
        <h1 style={{
          fontSize: "0.72rem", fontWeight: 600, letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--text-secondary)",
          fontFamily: "var(--font-body)", margin: 0,
        }}>
          New Project
        </h1>
      </header>

      <StepBar current={step} />

      <div style={{
        background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)", padding: "24px",
      }}>
        {step === 1 && (
          <Step1
            name={name} setName={setName}
            relPath={relPath} setRelPath={setRelPath}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <Step2
            stack={stack} setStack={setStack}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <Step3
            library={library}
            selectedIds={selectedIds}
            toggleId={toggleId}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
          />
        )}
        {step === 4 && (
          <Step4
            name={name} relPath={relPath || slugify(name)} stack={stack}
            selectedIds={selectedIds}
            submitting={submitting}
            result={result}
            onBack={() => { setResult(null); setStep(3); }}
            onSubmit={() => void handleSubmit()}
          />
        )}
      </div>
    </div>
  );
}
