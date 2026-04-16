"use client";

import { CodeBlock } from "@/components/ui/code-block";
import {
  CLAUDE_MD_TODO_BLOCK,
  CLAUDE_MD_MANUAL_STEPS_BLOCK,
  HOOKS_SETTINGS_SNIPPET,
  HOOKS_VALIDATE_TODO,
  HOOKS_VALIDATE_MANUAL_STEPS,
} from "@/lib/setup-content";

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
    </div>
  );
}
