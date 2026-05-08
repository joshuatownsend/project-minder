"use client";

import { useEffect, useState } from "react";
import type { MinderConfig, PricingRule, ScheduleMode } from "@/lib/types";
import { SCHEDULE_MODES } from "@/lib/types";
import { S } from "./styles";
import { SUPPORTED_CURRENCIES, CURRENCY_NAMES } from "@/lib/currencies";
import { invalidateCurrencyCache } from "@/hooks/useCurrency";
import { useQuota } from "@/hooks/useQuota";
import { QuotaBurndownChart } from "@/components/QuotaBurndownChart";

interface FxData {
  base: string;
  rates: Record<string, number>;
  fetchedAt: string | null;
}

type RuleRow = PricingRule & { _key: number };

let keyCounter = 0;
function newKey() { return ++keyCounter; }

function toRow(r: PricingRule): RuleRow {
  return { ...r, _key: newKey() };
}

function emptyRow(): RuleRow {
  return { pattern: "", _key: newKey() };
}

export function CostSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [fx, setFx] = useState<FxData | null>(null);
  const [currency, setCurrency] = useState(config?.currency ?? "USD");
  const [currencySaving, setCurrencySaving] = useState(false);

  const [rows, setRows] = useState<RuleRow[]>(() =>
    (config?.pricingRules ?? []).map(toRow)
  );
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesMsg, setRulesMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(config?.scheduleMode ?? "weekdays");
  const [scheduleSaving, setScheduleSaving] = useState(false);

  const quota = useQuota();

  useEffect(() => {
    fetch("/api/integrations/fx")
      .then((r) => r.json())
      .then((d) => setFx(d as FxData))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setCurrency(config?.currency ?? "USD");
  }, [config?.currency]);

  useEffect(() => {
    setRows((config?.pricingRules ?? []).map(toRow));
  }, [config?.pricingRules]);

  useEffect(() => {
    setScheduleMode(config?.scheduleMode ?? "weekdays");
  }, [config?.scheduleMode]);

  async function handleCurrencyChange(next: string) {
    setCurrency(next);
    setCurrencySaving(true);
    try {
      await onConfigChange({ currency: next });
      invalidateCurrencyCache();
    } finally {
      setCurrencySaving(false);
    }
  }

  async function handleSaveRules() {
    setRulesSaving(true);
    setRulesMsg(null);
    try {
      // Validate patterns locally before sending
      for (const row of rows) {
        if (!row.pattern.trim()) {
          setRulesMsg({ text: "All rules must have a non-empty pattern.", ok: false });
          return;
        }
      }
      const rules: PricingRule[] = rows.map(({ _key: _, ...rest }) => rest);
      await onConfigChange({ pricingRules: rules });
      setRulesMsg({ text: "Pricing rules saved.", ok: true });
    } catch (err) {
      setRulesMsg({ text: (err as Error).message, ok: false });
    } finally {
      setRulesSaving(false);
    }
  }

  async function handleResetRules() {
    setRulesSaving(true);
    setRulesMsg(null);
    try {
      await onConfigChange({ pricingRules: [] });
      setRows([]);
      setRulesMsg({ text: "Pricing rules cleared — LiteLLM defaults apply.", ok: true });
    } catch (err) {
      setRulesMsg({ text: (err as Error).message, ok: false });
    } finally {
      setRulesSaving(false);
    }
  }

  async function handleScheduleChange(next: ScheduleMode) {
    const prev = scheduleMode;
    setScheduleMode(next);
    setScheduleSaving(true);
    try {
      await onConfigChange({ scheduleMode: next });
    } catch {
      setScheduleMode(prev);
    } finally {
      setScheduleSaving(false);
    }
  }

  function updateRow(key: number, field: keyof PricingRule, value: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (r._key !== key) return r;
        if (field === "pattern") return { ...r, pattern: value };
        const num = value === "" ? undefined : parseFloat(value);
        return { ...r, [field]: num };
      })
    );
    setRulesMsg(null);
  }

  function deleteRow(key: number) {
    setRows((prev) => prev.filter((r) => r._key !== key));
    setRulesMsg(null);
  }

  const fxRate = currency === "USD" ? 1 : (fx?.rates[currency] ?? null);
  const fxLabel = fxRate !== null
    ? `1 USD = ${fxRate.toFixed(4)} ${currency}`
    : fx === null ? "Loading…" : "Rate unavailable";

  const rateInput: React.CSSProperties = {
    ...S.input,
    width: "80px",
    textAlign: "right",
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
  };

  return (
    <section>
      <h2 style={S.sectionTitle}>Cost</h2>
      <p style={S.desc}>
        Configure currency display and per-model pricing rule overrides.
        Currency applies to all cost figures in the dashboard.
        Pricing rules override LiteLLM defaults immediately for new session ingest.
      </p>

      {/* ── Currency ─────────────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-primary)", marginBottom: "12px" }}>
          Display Currency
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
          <select
            style={{ ...S.select, width: "240px" }}
            value={currency}
            onChange={(e) => handleCurrencyChange(e.target.value)}
            disabled={currencySaving}
          >
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c} — {CURRENCY_NAMES[c] ?? c}</option>
            ))}
          </select>

          {currencySaving && (
            <span style={S.muted}>Saving…</span>
          )}
        </div>

        <div style={{ ...S.muted }}>
          {currency !== "USD" ? fxLabel : "No conversion — costs shown in USD."}
          {fx?.fetchedAt && (
            <span style={{ marginLeft: "8px", opacity: 0.6 }}>
              (cached {new Date(fx.fetchedAt).toLocaleDateString()})
            </span>
          )}
        </div>

        <div style={{ ...S.muted, marginTop: "6px" }}>
          Exchange rates fetched from{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>api.frankfurter.dev</code> and cached for 24 hours.
          Original costs are stored in USD; conversion is display-only.
        </div>
      </div>

      {/* ── Pricing Rules ────────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-primary)", marginBottom: "4px" }}>
          Pricing Rule Overrides
        </div>

        <div style={{ ...S.muted, marginBottom: "16px" }}>
          Override LiteLLM pricing per model. Use <code style={{ fontFamily: "var(--font-mono)" }}>*</code>{" "}
          as a wildcard (e.g. <code style={{ fontFamily: "var(--font-mono)" }}>claude-opus-4*</code>).
          Longer patterns take priority. Rates are USD per 1M tokens.
          Leave a rate blank to keep the LiteLLM default for that field.
        </div>

        {rows.length > 0 ? (
          <div style={{ overflowX: "auto", marginBottom: "12px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
              <thead>
                <tr style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.68rem" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px 8px 0", fontWeight: 500 }}>Pattern</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 8px", fontWeight: 500, whiteSpace: "nowrap" }}>Input $/M</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 8px", fontWeight: 500, whiteSpace: "nowrap" }}>Output $/M</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 8px", fontWeight: 500, whiteSpace: "nowrap" }}>Cache Read $/M</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 8px", fontWeight: 500, whiteSpace: "nowrap" }}>Cache Write $/M</th>
                  <th style={{ width: "28px" }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row._key} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: "6px 8px 6px 0" }}>
                      <input
                        type="text"
                        style={{ ...S.input, width: "180px", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}
                        value={row.pattern}
                        placeholder="claude-opus-4*"
                        onChange={(e) => updateRow(row._key, "pattern", e.target.value)}
                      />
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      <input
                        type="number"
                        style={rateInput}
                        value={row.inputUsdPerMillion ?? ""}
                        placeholder="—"
                        min={0}
                        step="any"
                        onChange={(e) => updateRow(row._key, "inputUsdPerMillion", e.target.value)}
                      />
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      <input
                        type="number"
                        style={rateInput}
                        value={row.outputUsdPerMillion ?? ""}
                        placeholder="—"
                        min={0}
                        step="any"
                        onChange={(e) => updateRow(row._key, "outputUsdPerMillion", e.target.value)}
                      />
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      <input
                        type="number"
                        style={rateInput}
                        value={row.cacheReadUsdPerMillion ?? ""}
                        placeholder="—"
                        min={0}
                        step="any"
                        onChange={(e) => updateRow(row._key, "cacheReadUsdPerMillion", e.target.value)}
                      />
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      <input
                        type="number"
                        style={rateInput}
                        value={row.cacheCreateUsdPerMillion ?? ""}
                        placeholder="—"
                        min={0}
                        step="any"
                        onChange={(e) => updateRow(row._key, "cacheCreateUsdPerMillion", e.target.value)}
                      />
                    </td>
                    <td style={{ padding: "6px 0 6px 8px" }}>
                      <button
                        style={{ ...S.btn, padding: "3px 7px", color: "var(--status-error-text)", borderColor: "var(--status-error-border)" }}
                        onClick={() => deleteRow(row._key)}
                        title="Remove rule"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{
            padding: "12px", borderRadius: "var(--radius)", marginBottom: "12px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "center",
          }}>
            No overrides — LiteLLM defaults apply.
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
          <button
            style={S.btn}
            onClick={() => { setRows((prev) => [...prev, emptyRow()]); setRulesMsg(null); }}
          >
            + Add rule
          </button>
          <button
            style={{ ...S.btn, background: "var(--info)", color: "#fff", borderColor: "var(--info)", opacity: rulesSaving ? 0.4 : 1 }}
            disabled={rulesSaving}
            onClick={handleSaveRules}
          >
            {rulesSaving ? "Saving…" : "Save rules"}
          </button>
          {rows.length > 0 && (
            <button
              style={{ ...S.btn, color: "var(--status-error-text)", borderColor: "var(--status-error-border)", opacity: rulesSaving ? 0.4 : 1 }}
              disabled={rulesSaving}
              onClick={handleResetRules}
            >
              Reset to defaults
            </button>
          )}
        </div>

        {rulesMsg && (
          <div style={{ fontSize: "0.74rem", color: rulesMsg.ok ? "var(--status-active-text)" : "var(--status-error-text)" }}>
            {rulesMsg.text}
          </div>
        )}

        <div style={{
          padding: "10px 12px", borderRadius: "var(--radius)", marginTop: "8px",
          background: "var(--bg-elevated)", fontSize: "0.74rem",
          color: "var(--text-muted)", lineHeight: 1.6,
        }}>
          <strong style={{ color: "var(--text-secondary)" }}>Note:</strong>{" "}
          Pricing rule changes apply to new session ingest immediately.
          Previously indexed session costs are not retroactively recalculated.
        </div>
      </div>

      {/* ── Quota Burndown ───────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-primary)", marginBottom: "4px" }}>
          Usage Quota
        </div>
        <div style={{ ...S.muted, marginBottom: "16px" }}>
          Claude Max unified rate limits — 5-hour and 7-day rolling windows.
          Select your typical work schedule for paced projections.
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
          <label htmlFor="schedule-mode-select" style={{ ...S.label, flexShrink: 0 }}>Schedule</label>
          <select
            id="schedule-mode-select"
            style={{ ...S.select, width: "240px" }}
            value={scheduleMode}
            onChange={(e) => handleScheduleChange(e.target.value as ScheduleMode)}
            disabled={scheduleSaving}
          >
            {SCHEDULE_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          {scheduleSaving && <span style={S.muted}>Saving…</span>}
        </div>

        {quota === null ? (
          <div style={S.muted}>Loading quota…</div>
        ) : !quota.configured ? (
          <div style={{
            padding: "10px 12px", borderRadius: "var(--radius)",
            background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
            fontSize: "0.74rem", color: "var(--text-muted)", lineHeight: 1.6,
          }}>
            <strong style={{ color: "var(--text-secondary)" }}>Not available:</strong>{" "}
            {quota.reason}
          </div>
        ) : (
          <QuotaBurndownChart data={quota} scheduleMode={scheduleMode} />
        )}
      </div>
    </section>
  );
}
