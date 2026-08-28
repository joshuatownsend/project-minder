"use client";

import { useState, useEffect } from "react";
import type { MinderConfig } from "@/lib/types";
import {
  SUBSTRATE_ADAPTER_ID,
  normalizeEnabledAdapters,
} from "@/lib/adapters/substrate";
import { S } from "./styles";

interface AdapterEntry {
  id: string;
  displayName: string;
}

const ADAPTER_DESCRIPTIONS: Record<string, string> = {
  claude:
    "Reads sessions from ~/.claude/projects/. Always on — this setting adds " +
    "harnesses alongside Claude rather than filtering sources.",
  codex: "Reads sessions from Codex CLI.",
  gemini: "Reads sessions from Gemini CLI.",
};

export function AdaptersSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [adapters, setAdapters] = useState<AdapterEntry[]>([]);
  const [saving, setSaving] = useState(false);
  // Through the shared rule rather than a second spelling of it: prepending
  // unconditionally reordered a hand-edited `["codex", "claude"]`, which
  // contradicts the no-reorder property the rule is tested for and would have
  // written a pointless config diff on the next save. (Copilot, PR #509.)
  const enabled = new Set(
    normalizeEnabledAdapters(config?.enabledAdapters ?? [])
  );

  useEffect(() => {
    fetch("/api/adapters")
      .then((r) => r.json())
      .then((data: AdapterEntry[]) => setAdapters(data))
      .catch(() => {});
  }, []);

  async function toggleAdapter(id: string, on: boolean) {
    const next = new Set(enabled);
    if (on) next.add(id); else next.delete(id);
    setSaving(true);
    try {
      await onConfigChange({
        enabledAdapters: normalizeEnabledAdapters([...next]),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Adapters</h2>
      <p style={S.desc}>
        Enable additional session sources. Enabling one indexes its transcripts alongside
        Claude&apos;s and includes them in the browser and in analytics.
      </p>
      <p style={{ ...S.desc, marginTop: "-6px" }}>
        Claude is the substrate and is always read — see the note on its row below.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {adapters.map((adapter) => {
          const isEnabled = enabled.has(adapter.id);
          return (
            <div key={adapter.id} style={S.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={S.label}>{adapter.displayName}</span>
                  <span style={{ ...S.badge, color: isEnabled ? "var(--status-active-text)" : "var(--text-muted)", borderColor: isEnabled ? "var(--status-active-border)" : "var(--border-subtle)", background: isEnabled ? "var(--status-active-bg)" : "transparent" }}>
                    {isEnabled ? "Active" : "Disabled"}
                  </span>
                </div>
                <div style={{ ...S.muted, marginTop: "2px" }}>
                  {ADAPTER_DESCRIPTIONS[adapter.id] ?? `${adapter.displayName} adapter.`}
                </div>
              </div>
              {adapter.id === SUBSTRATE_ADAPTER_ID ? (
                // Not a disabled button — there is no state to reach, so
                // offering the control at all would be a lie (#491). Minder
                // reads Claude on both backends regardless of this setting,
                // and a toggle the app does not honour is worse than no
                // toggle.
                <span style={{ ...S.muted, whiteSpace: "nowrap" }}>Always on</span>
              ) : (
                <button
                  style={{ ...S.btn, cursor: "pointer" }}
                  disabled={saving}
                  onClick={() => toggleAdapter(adapter.id, !isEnabled)}
                >
                  {isEnabled ? "Disable" : "Enable"}
                </button>
              )}
            </div>
          );
        })}
        {adapters.length === 0 && (
          <div data-loading="true" style={S.muted}>Loading adapters…</div>
        )}
      </div>
    </section>
  );
}
