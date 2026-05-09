"use client";

import { useState, useEffect } from "react";
import type { MinderConfig } from "@/lib/types";
import { S } from "./styles";

interface AdapterEntry {
  id: string;
  displayName: string;
}

const ADAPTER_DESCRIPTIONS: Record<string, string> = {
  claude: "Reads sessions from ~/.claude/projects/.",
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
  const enabled = new Set(config?.enabledAdapters ?? ["claude"]);

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
      await onConfigChange({ enabledAdapters: [...next] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Adapters</h2>
      <p style={S.desc}>
        Enable or disable session sources. Disabling an adapter hides its sessions from the browser
        and excludes them from analytics.
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
              <button
                style={{ ...S.btn, cursor: "pointer" }}
                disabled={saving}
                onClick={() => toggleAdapter(adapter.id, !isEnabled)}
              >
                {isEnabled ? "Disable" : "Enable"}
              </button>
            </div>
          );
        })}
        {adapters.length === 0 && (
          <div style={S.muted}>Loading adapters…</div>
        )}
      </div>
    </section>
  );
}
