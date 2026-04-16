"use client";

import { useState, useEffect } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { CodeBlock } from "@/components/ui/code-block";
import {
  CLAUDE_MD_TODO_BLOCK,
  CLAUDE_MD_MANUAL_STEPS_BLOCK,
  HOOKS_SETTINGS_SNIPPET,
  HOOKS_VALIDATE_TODO,
  HOOKS_VALIDATE_MANUAL_STEPS,
} from "@/lib/setup-content";
import type { ApplyResult, ApplyStatus } from "@/lib/setupApply";

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
      <span
        style={{
          fontSize: "0.62rem",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

function StepLabel({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "10px" }}>
      <span
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "20px",
          height: "20px",
          borderRadius: "50%",
          background: "var(--accent-bg)",
          border: "1px solid var(--accent-border)",
          color: "var(--accent)",
          fontSize: "0.6rem",
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          marginTop: "1px",
        }}
      >
        {n}
      </span>
      <span
        style={{
          fontSize: "0.8rem",
          color: "var(--text-secondary)",
          lineHeight: 1.5,
        }}
      >
        {children}
      </span>
    </div>
  );
}

export function SetupGuide() {
  return (
    <div style={{ maxWidth: "800px", padding: "32px 0" }}>
      {/* Page header */}
      <div style={{ marginBottom: "32px" }}>
        <h1
          style={{
            fontSize: "1.2rem",
            fontWeight: 600,
            color: "var(--text-primary)",
            fontFamily: "var(--font-body)",
            marginBottom: "6px",
          }}
        >
          Setup Guide
        </h1>
        <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Project Minder reads <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--accent)" }}>TODO.md</code>,{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--accent)" }}>MANUAL_STEPS.md</code>, and{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--accent)" }}>INSIGHTS.md</code>{" "}
          from each project. Use the instructions below to configure Claude Code in your projects to generate and maintain these files.
        </p>
      </div>

      {/* What Project Minder scans for */}
      <div style={{ marginBottom: "36px" }}>
        <SectionHeader label="What Project Minder Scans For" />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "12px",
          }}
        >
          {[
            {
              file: "TODO.md",
              desc: "Open and completed task checklist. Shows counts on project cards and in the detail view.",
            },
            {
              file: "MANUAL_STEPS.md",
              desc: "Developer actions Claude can't perform itself (migrations, env vars, external setup). Tracked cross-project in the Steps dashboard.",
            },
            {
              file: "INSIGHTS.md",
              desc: "Auto-generated from Claude session logs — no setup needed. Captured insight markers are synced to this file automatically.",
            },
          ].map(({ file, desc }) => (
            <div
              key={file}
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                padding: "14px 16px",
              }}
            >
              <div
                style={{
                  fontSize: "0.72rem",
                  fontFamily: "var(--font-mono)",
                  color: "var(--accent)",
                  fontWeight: 600,
                  marginBottom: "6px",
                  letterSpacing: "0.04em",
                }}
              >
                {file}
              </div>
              <p style={{ fontSize: "0.76rem", color: "var(--text-secondary)", lineHeight: 1.5, margin: 0 }}>
                {desc}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Step 1: CLAUDE.md instructions (always required) */}
      <div style={{ marginBottom: "36px" }}>
        <SectionHeader label="Step 1 — CLAUDE.md Instructions (required)" />
        <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "20px" }}>
          Add these blocks to your project&rsquo;s{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>CLAUDE.md</code>. Claude reads this file at the start of each session — these instructions tell it <em>when</em> to write to these files and <em>what format</em> to use.
        </p>
        <StepLabel n={1}>
          Add the TODO rules to your <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>CLAUDE.md</code>
        </StepLabel>
        <CodeBlock
          code={CLAUDE_MD_TODO_BLOCK}
          filename="CLAUDE.md — TODO section"
        />
        <StepLabel n={2}>
          Add the Manual Steps rules to your <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>CLAUDE.md</code>
        </StepLabel>
        <CodeBlock
          code={CLAUDE_MD_MANUAL_STEPS_BLOCK}
          filename="CLAUDE.md — Manual Steps section"
        />
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            fontSize: "0.76rem",
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>This is sufficient for most projects.</strong>{" "}
          The instructions are advisory — Claude follows them when writing these files. If you want guaranteed format compliance that blocks malformed writes before they touch disk, continue to Step 2.
        </div>
      </div>

      {/* Step 2: Hooks (optional, additive) */}
      <div style={{ marginBottom: "36px" }}>
        <SectionHeader label="Step 2 — Claude Code Hooks (optional)" />
        <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "20px" }}>
          Claude Code&rsquo;s <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>PreToolUse</code> hooks intercept every{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>Write</code> and{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>Edit</code>{" "}
          call. If Claude tries to write a malformed entry, the hook blocks the write and returns an error — nothing touches disk. These complement the CLAUDE.md instructions; they don&rsquo;t replace them.
        </p>
        <StepLabel n={1}>
          Create the hooks directory in your project: <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>mkdir -p .claude/hooks</code>
        </StepLabel>
        <StepLabel n={2}>
          Merge the hook config into <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>.claude/settings.local.json</code> (create the file if it doesn&rsquo;t exist)
        </StepLabel>
        <CodeBlock
          code={HOOKS_SETTINGS_SNIPPET}
          filename=".claude/settings.local.json"
          language="json"
        />
        <StepLabel n={3}>
          Create the TODO.md validation script
        </StepLabel>
        <CodeBlock
          code={HOOKS_VALIDATE_TODO}
          filename=".claude/hooks/validate-todo-format.mjs"
          language="javascript"
        />
        <StepLabel n={4}>
          Create the MANUAL_STEPS.md validation script
        </StepLabel>
        <CodeBlock
          code={HOOKS_VALIDATE_MANUAL_STEPS}
          filename=".claude/hooks/validate-manual-steps.mjs"
          language="javascript"
        />
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            fontSize: "0.76rem",
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Note:</strong> <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.74rem" }}>settings.local.json</code> is per-machine. Add it to your <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.74rem" }}>.gitignore</code> if your project has a shared <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.74rem" }}>settings.json</code>, or commit it if the hooks should apply to all contributors.
        </div>
      </div>

      {/* Format reference */}
      <div style={{ marginBottom: "36px" }}>
        <SectionHeader label="Format Reference" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {/* TODO.md format */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              padding: "14px 16px",
            }}
          >
            <div
              style={{
                fontSize: "0.65rem",
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: "10px",
              }}
            >
              TODO.md
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {[
                ["- [ ] text", "pending task"],
                ["- [x] text", "completed task"],
                ["# Heading", "optional grouping"],
                ["other lines", "ignored by scanner"],
              ].map(([code, desc]) => (
                <li
                  key={code}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: "8px",
                    marginBottom: "5px",
                    fontSize: "0.74rem",
                  }}
                >
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                      color: "var(--accent)",
                      flexShrink: 0,
                    }}
                  >
                    {code}
                  </code>
                  <span style={{ color: "var(--text-muted)" }}>{desc}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* MANUAL_STEPS.md format */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              padding: "14px 16px",
            }}
          >
            <div
              style={{
                fontSize: "0.65rem",
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: "10px",
              }}
            >
              MANUAL_STEPS.md
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {[
                ["## YYYY-MM-DD [HH:MM] | slug | title", "entry header (required)"],
                ["- [ ] step text", "pending step"],
                ["- [x] step text", "completed step"],
                ["  detail line", "indented detail beneath a step"],
                ["---", "entry separator (required at end)"],
              ].map(([code, desc]) => (
                <li
                  key={code}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: "8px",
                    marginBottom: "5px",
                    fontSize: "0.74rem",
                  }}
                >
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.68rem",
                      color: "var(--accent)",
                      flexShrink: 0,
                    }}
                  >
                    {code}
                  </code>
                  <span style={{ color: "var(--text-muted)" }}>{desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Apply to a project */}
      <div style={{ marginBottom: "36px" }}>
        <SectionHeader label="Apply to a Project" />
        <ApplyPanel />
      </div>
    </div>
  );
}

// ─── Apply Panel ─────────────────────────────────────────────────────────────

interface ProjectOption {
  slug: string;
  name: string;
}

function statusIcon(status: ApplyStatus) {
  if (status === "applied") {
    return (
      <span style={{ color: "var(--accent)", fontSize: "0.72rem", fontWeight: 600 }}>
        ✓ applied
      </span>
    );
  }
  return (
    <span style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>
      already present
    </span>
  );
}

function ApplyPanel() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [applyStep1, setApplyStep1] = useState(true);
  const [applyStep2, setApplyStep2] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: { projects?: ProjectOption[] }) => {
        const list = data.projects ?? [];
        setProjects(list);
        if (list.length > 0) setSelectedSlug(list[0].slug);
      })
      .catch(() => {});
  }, []);

  async function handleApply() {
    if (!selectedSlug) return;
    const action = applyStep1 && applyStep2 ? "both" : applyStep1 ? "claude-md" : "hooks";
    setApplying(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/setup/${selectedSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json() as ApplyResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Unknown error");
      } else {
        setResult(data);
      }
    } catch {
      setError("Request failed");
    } finally {
      setApplying(false);
    }
  }

  const canApply = selectedSlug && (applyStep1 || applyStep2) && !applying;
  const checkboxStyle = {
    width: "14px",
    height: "14px",
    accentColor: "var(--accent)",
    cursor: "pointer",
    flexShrink: 0 as const,
  };
  const labelStyle = {
    fontSize: "0.78rem",
    color: "var(--text-secondary)",
    cursor: "pointer",
  };

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        padding: "18px 20px",
      }}
    >
      {/* Project picker */}
      <div style={{ marginBottom: "16px" }}>
        <label
          style={{
            display: "block",
            fontSize: "0.72rem",
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginBottom: "6px",
          }}
        >
          Project
        </label>
        <div style={{ position: "relative", display: "inline-block" }}>
          <select
            value={selectedSlug}
            onChange={(e) => { setSelectedSlug(e.target.value); setResult(null); setError(null); }}
            style={{
              appearance: "none",
              background: "var(--bg-base)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              color: "var(--text-primary)",
              fontSize: "0.8rem",
              fontFamily: "var(--font-body)",
              padding: "6px 32px 6px 10px",
              cursor: "pointer",
              outline: "none",
              minWidth: "220px",
            }}
          >
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
          <ChevronDown
            size={12}
            style={{
              position: "absolute",
              right: "10px",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          />
        </div>
      </div>

      {/* Step checkboxes */}
      <div style={{ marginBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <input
            type="checkbox"
            checked={applyStep1}
            onChange={(e) => setApplyStep1(e.target.checked)}
            style={checkboxStyle}
          />
          <span style={labelStyle}>Step 1 — CLAUDE.md instructions</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <input
            type="checkbox"
            checked={applyStep2}
            onChange={(e) => setApplyStep2(e.target.checked)}
            style={checkboxStyle}
          />
          <span style={labelStyle}>Step 2 — Claude Code hooks</span>
        </label>
      </div>

      {/* Apply button */}
      <button
        onClick={handleApply}
        disabled={!canApply}
        style={{
          padding: "6px 16px",
          background: canApply ? "var(--accent-bg)" : "var(--bg-base)",
          border: "1px solid var(--accent-border)",
          borderRadius: "var(--radius)",
          color: canApply ? "var(--accent)" : "var(--text-muted)",
          fontSize: "0.78rem",
          fontWeight: 600,
          fontFamily: "var(--font-body)",
          cursor: canApply ? "pointer" : "not-allowed",
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          transition: "background 0.12s",
        }}
      >
        {applying ? (
          <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
        ) : (
          <Check size={12} />
        )}
        {applying ? "Applying…" : "Apply"}
      </button>

      {/* Result */}
      {result && (
        <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {result.claudeMd && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.76rem" }}>
                <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>CLAUDE.md — TODO block</span>
                {statusIcon(result.claudeMd.todo)}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.76rem" }}>
                <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>CLAUDE.md — Manual Steps block</span>
                {statusIcon(result.claudeMd.manualSteps)}
              </div>
            </>
          )}
          {result.hooks && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.76rem" }}>
                <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>.claude/settings.local.json</span>
                {statusIcon(result.hooks.settingsJson)}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.76rem" }}>
                <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>validate-todo-format.mjs</span>
                {statusIcon(result.hooks.validateTodo)}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.76rem" }}>
                <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>validate-manual-steps.mjs</span>
                {statusIcon(result.hooks.validateManualSteps)}
              </div>
            </>
          )}
          <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "4px" }}>
            Originals backed up as <code style={{ fontFamily: "var(--font-mono)" }}>.minder-bak</code> where applicable.
          </p>
        </div>
      )}

      {error && (
        <p style={{ marginTop: "12px", fontSize: "0.76rem", color: "var(--destructive, #f87171)" }}>
          Error: {error}
        </p>
      )}
    </div>
  );
}
