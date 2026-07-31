"use client";

import { useState } from "react";
import type { MinderConfig } from "@/lib/types";
import {
  MAX_PATTERN_LENGTH,
  MAX_RULES,
  RULE_CHANNELS,
  RULE_FIELDS,
  RULE_FIELD_META,
  RULE_OPERATORS,
  RULE_OPERATOR_META,
  RULE_SEVERITIES,
  type NotificationRule,
  type RuleChannel,
  type RuleField,
  type RuleOperator,
  type RuleSeverity,
} from "@/lib/notifications/rules/types";
import { RULE_PRESETS, instantiatePreset } from "@/lib/notifications/rules/presets";
import { S } from "./styles";
import { Toggle } from "./Toggle";

const SEVERITY_COLOR: Record<RuleSeverity, string> = {
  info: "var(--text-muted)",
  warn: "var(--accent)",
  critical: "var(--error, #f87171)",
};

function blankRule(): NotificationRule {
  return {
    // Not crypto — this only needs to be unique among ≤50 rules in one file,
    // and the validator rejects duplicates anyway.
    id: `rule-${Math.random().toString(36).slice(2, 10)}`,
    name: "",
    enabled: true,
    field: "tool.input",
    op: "contains",
    pattern: "",
    channels: { os: true },
    severity: "warn",
    cooldownSec: 60,
  };
}

export function NotificationRulesEditor({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const rules = config?.notificationRules ?? [];
  const [draft, setDraft] = useState<NotificationRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: NotificationRule[]) {
    setBusy(true);
    setError(null);
    try {
      await onConfigChange({ notificationRules: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(id: string, enabled: boolean) {
    await save(rules.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }

  async function deleteRule(id: string) {
    await save(rules.filter((r) => r.id !== id));
  }

  async function addPreset(presetId: string) {
    const preset = RULE_PRESETS.find((p) => p.rule.id === presetId);
    if (!preset) return;
    // Re-adding an existing preset replaces it rather than duplicating — the
    // validator rejects duplicate ids, so a blind append would 400.
    const rule = instantiatePreset(preset);
    const existing = rules.findIndex((r) => r.id === rule.id);
    if (existing >= 0) {
      await save(rules.map((r, i) => (i === existing ? rule : r)));
    } else {
      await save([...rules, rule]);
    }
  }

  async function commitDraft() {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError("Give the rule a name — it becomes the notification title.");
      return;
    }
    if (!draft.pattern.trim()) {
      setError("A pattern is required.");
      return;
    }
    const existing = rules.findIndex((r) => r.id === draft.id);
    const next =
      existing >= 0 ? rules.map((r, i) => (i === existing ? draft : r)) : [...rules, draft];
    await save(next);
    setDraft(null);
  }

  const isNumericOp = draft ? RULE_OPERATOR_META[draft.op].numeric : false;
  const unusedPresets = RULE_PRESETS.filter((p) => !rules.some((r) => r.id === p.rule.id));

  return (
    <div style={{ marginTop: "24px" }}>
      <div style={{ marginBottom: "4px", fontSize: "0.78rem", fontWeight: 600, color: "var(--text-secondary)" }}>
        Rules
      </div>
      <p style={{ ...S.muted, margin: "0 0 12px 0" }}>
        Each rule watches one field of every live hook event and notifies when it matches. Requires
        the <strong>Live activity (hook server)</strong> flag and installed hooks — rules see only
        what the hook receiver receives.
      </p>

      {/* Existing rules */}
      {rules.length === 0 && (
        <div style={{ ...S.row, color: "var(--text-muted)", fontSize: "0.78rem" }}>
          No rules yet. Add one from the presets below, or build your own.
        </div>
      )}

      {rules.map((rule) => (
        <div key={rule.id} style={{ ...S.row, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span style={S.label}>{rule.name}</span>
              <span style={{ ...S.badge, color: SEVERITY_COLOR[rule.severity ?? "info"], borderColor: "currentColor" }}>
                {rule.severity ?? "info"}
              </span>
              {rule.projectSlug && <span style={S.badge}>{rule.projectSlug}</span>}
            </div>
            <div style={{ ...S.muted, fontFamily: "var(--font-mono)", fontSize: "0.7rem", marginTop: "3px", wordBreak: "break-all" }}>
              {rule.field} {RULE_OPERATOR_META[rule.op].label} “{rule.pattern}”
            </div>
            <div style={{ ...S.muted, fontSize: "0.7rem", marginTop: "2px" }}>
              via {RULE_CHANNELS.filter((c) => rule.channels[c]).join(", ") || "no channel — will not notify"}
              {rule.cooldownSec ? ` · ${rule.cooldownSec}s cooldown` : ""}
              {rule.events?.length ? ` · ${rule.events.join("/")}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Toggle
              value={rule.enabled}
              onChange={(v) => toggleRule(rule.id, v)}
              label={`enable rule ${rule.name}`}
            />
            <button style={S.btn} onClick={() => { setDraft({ ...rule }); setError(null); }} disabled={busy}>
              Edit
            </button>
            <button
              style={{ ...S.btn, color: "var(--error, #f87171)" }}
              onClick={() => deleteRule(rule.id)}
              disabled={busy}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      {/* Draft editor */}
      {draft && (
        <div style={{ ...S.card, marginTop: "12px" }}>
          <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "1fr 1fr" }}>
            <label style={{ gridColumn: "1 / -1" }}>
              <div style={{ ...S.muted, marginBottom: "4px" }}>Rule name (becomes the notification title)</div>
              <input
                style={S.input}
                value={draft.name}
                maxLength={80}
                placeholder="e.g. Secret file accessed"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>

            <label>
              <div style={{ ...S.muted, marginBottom: "4px" }}>Field</div>
              <select
                style={S.select}
                value={draft.field}
                onChange={(e) => setDraft({ ...draft, field: e.target.value as RuleField })}
              >
                {RULE_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {RULE_FIELD_META[f].label} ({f})
                  </option>
                ))}
              </select>
              <div style={{ ...S.muted, fontSize: "0.7rem", marginTop: "4px" }}>
                {RULE_FIELD_META[draft.field].hint}
              </div>
            </label>

            <label>
              <div style={{ ...S.muted, marginBottom: "4px" }}>Operator</div>
              <select
                style={S.select}
                value={draft.op}
                onChange={(e) => setDraft({ ...draft, op: e.target.value as RuleOperator })}
              >
                {RULE_OPERATORS.map((o) => (
                  <option key={o} value={o}>
                    {RULE_OPERATOR_META[o].label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              <div style={{ ...S.muted, marginBottom: "4px" }}>
                {isNumericOp ? "Threshold" : "Pattern"}
              </div>
              <input
                style={{ ...S.input, fontFamily: "var(--font-mono)" }}
                value={draft.pattern}
                maxLength={MAX_PATTERN_LENGTH}
                inputMode={isNumericOp ? "numeric" : "text"}
                placeholder={isNumericOp ? "60000" : ".env"}
                onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
              />
              {draft.op === "regex" && (
                <div style={{ ...S.muted, fontSize: "0.7rem", marginTop: "4px" }}>
                  Case-insensitive. A quantifier applied to a group that itself quantifies or
                  alternates (<code>(a+)+</code>, <code>(foo|bar)+</code>) is refused because it can
                  hang the hook receiver — lift the quantifier off the group. See Help → Notifications.
                </div>
              )}
            </label>

            <label>
              <div style={{ ...S.muted, marginBottom: "4px" }}>Severity</div>
              <select
                style={S.select}
                value={draft.severity ?? "info"}
                onChange={(e) => setDraft({ ...draft, severity: e.target.value as RuleSeverity })}
              >
                {RULE_SEVERITIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>

            <label>
              <div style={{ ...S.muted, marginBottom: "4px" }}>Cooldown (seconds)</div>
              <input
                style={S.input}
                type="number"
                min={0}
                max={86400}
                value={draft.cooldownSec ?? 60}
                onChange={(e) =>
                  setDraft({ ...draft, cooldownSec: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>

            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ ...S.muted, marginBottom: "6px" }}>Channels</div>
              <div style={{ display: "flex", gap: "16px" }}>
                {RULE_CHANNELS.map((ch) => (
                  <label key={ch} style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <Toggle
                      value={!!draft.channels[ch]}
                      onChange={(v) =>
                        setDraft({ ...draft, channels: { ...draft.channels, [ch]: v } as Partial<Record<RuleChannel, boolean>> })
                      }
                      label={`${ch} for this rule`}
                    />
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{ch}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            <button style={S.btn} onClick={commitDraft} disabled={busy}>
              Save rule
            </button>
            <button style={{ ...S.btn, color: "var(--text-muted)" }} onClick={() => { setDraft(null); setError(null); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!draft && (
        <button
          style={{ ...S.btn, marginTop: "12px" }}
          onClick={() => { setDraft(blankRule()); setError(null); }}
          disabled={busy || rules.length >= MAX_RULES}
        >
          Add custom rule
        </button>
      )}

      {/* Presets */}
      {unusedPresets.length > 0 && (
        <div style={{ marginTop: "20px" }}>
          <div style={{ ...S.muted, marginBottom: "8px", fontWeight: 600 }}>Suggested rules</div>
          {unusedPresets.map((p) => (
            <div key={p.rule.id} style={{ ...S.row, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={S.label}>{p.rule.name}</span>
                  <span style={{ ...S.badge, color: SEVERITY_COLOR[p.rule.severity ?? "info"], borderColor: "currentColor" }}>
                    {p.rule.severity ?? "info"}
                  </span>
                </div>
                <div style={{ ...S.muted, marginTop: "3px" }}>{p.rationale}</div>
              </div>
              <button style={S.btn} onClick={() => addPreset(p.rule.id)} disabled={busy || rules.length >= MAX_RULES}>
                Add
              </button>
            </div>
          ))}
        </div>
      )}

      {rules.length >= MAX_RULES && (
        <div style={{ ...S.muted, marginTop: "8px", color: "var(--accent)" }}>
          Rule limit reached ({MAX_RULES}). Delete one to add another.
        </div>
      )}

      {error && (
        <div style={{ marginTop: "12px", fontSize: "0.78rem", color: "var(--error, #f87171)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
