"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { MinderConfig, PathMapping } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { deriveWslMappingFromHome } from "@/lib/wslCompanions";
import { S } from "./styles";

interface WslDistroSuggestion {
  name: string;
  state: string;
  isDefault: boolean;
  suggestedRoots: string[];
  claudeHomes: string[];
}

/**
 * Derive the path mapping implied by a WSL Claude-home UNC path. Whatever
 * directory contains `.claude` is taken as the home, at any depth:
 *   \\wsl.localhost\<distro>\home\<user>\.claude → { from: "/home/<user>", … }
 *   \\wsl.localhost\<distro>\root\.claude        → { from: "/root", … }
 *   \\wsl.localhost\<distro>\opt\me\.claude      → { from: "/opt/me", … }
 * `/home/<user>` is the common shape, not a requirement — restricting to it
 * meant a root-user WSL setup could never correlate its sessions.
 *
 * Returns null for non-WSL paths and for anything not ending in `.claude`.
 *
 * Delegates to the shared derivation rather than parsing UNC paths a second
 * time (#326). The Scan Roots section derives the same mapping from a scan
 * root, and two independent parsers of the same path shape is the pattern that
 * produced several defects in #324 — one that only shows up when they drift.
 */
export function deriveWslMapping(claudeHome: string): PathMapping | null {
  return deriveWslMappingFromHome(claudeHome);
}

const sameMapping = (a: PathMapping, b: PathMapping) =>
  a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase();

export function ClaudeHomesSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const { showToast } = useToast();
  const [homes, setHomes] = useState<string[]>([]);
  const [mappings, setMappings] = useState<PathMapping[]>([]);
  const [newHome, setNewHome] = useState("");
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [wslHomes, setWslHomes] = useState<{ home: string; distro: string; state: string }[] | null>(null);

  const savedHomes = config?.claudeHomes ?? [];
  const savedMappings = config?.pathMappings ?? [];

  useEffect(() => {
    if (config) {
      setHomes(config.claudeHomes ?? []);
      setMappings(config.pathMappings ?? []);
    }
    // Re-seed from the persisted values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(config?.claudeHomes), JSON.stringify(config?.pathMappings)]);

  const isDirty =
    config !== null &&
    (JSON.stringify(homes) !== JSON.stringify(savedHomes) ||
      JSON.stringify(mappings) !== JSON.stringify(savedMappings));

  /** Add a home; when it's a WSL home, auto-add its implied path mapping. */
  function addHome(home: string) {
    const trimmed = home.trim();
    if (!trimmed || homes.includes(trimmed)) return;
    setHomes((prev) => [...prev, trimmed]);
    const implied = deriveWslMapping(trimmed);
    if (implied) {
      setMappings((prev) => (prev.some((m) => sameMapping(m, implied)) ? prev : [...prev, implied]));
    }
  }

  async function detectWsl() {
    setDetecting(true);
    try {
      const res = await fetch("/api/wsl");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { available: boolean; distros: WslDistroSuggestion[] } = await res.json();
      if (!data.available) {
        setWslHomes([]);
        return;
      }
      setWslHomes(
        data.distros.flatMap((d) =>
          d.claudeHomes.length > 0
            ? d.claudeHomes.map((home) => ({ home, distro: d.name, state: d.state }))
            : [{ home: "", distro: d.name, state: d.state }]
        )
      );
    } catch (e) {
      showToast("WSL detection failed", e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await onConfigChange({ claudeHomes: homes, pathMappings: mappings });
      // Rescan so session counts/status re-derive with the new homes without
      // waiting out the scan cache. Non-fatal on failure — config is saved.
      try {
        await fetch("/api/scan", { method: "POST" });
        showToast("Claude homes saved", "Rescanning projects now");
      } catch {
        showToast("Claude homes saved", "Applies when the scan cache expires (up to 5 min)");
      }
    } catch {
      // onConfigChange already toasted.
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Claude Homes</h2>
      <p style={S.desc}>
        Extra <code style={{ fontFamily: "var(--font-mono)" }}>.claude</code> directories to read sessions
        from, beyond this machine&apos;s own — the main use case is a WSL distro&apos;s{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>{"\\\\wsl.localhost\\<distro>\\home\\<user>\\.claude"}</code>.
        Sessions recorded there reference Linux paths, so each WSL home needs a matching{" "}
        <strong>path mapping</strong> (added automatically for detected homes) to correlate with the
        UNC-scanned projects. A home inside a stopped distro is skipped until the distro runs — Minder never
        starts one.
      </p>

      <div style={S.card}>
        {config === null ? (
          <p style={S.muted}>Loading…</p>
        ) : (
          <>
            <div style={{ ...S.label, marginBottom: "6px" }}>Extra homes</div>
            {homes.length === 0 && <p style={S.muted}>None configured — only this machine&apos;s ~/.claude is read.</p>}
            {homes.map((h) => (
              <div key={h} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "0.74rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h}
                </code>
                <button
                  style={{ background: "none", border: "none", padding: "3px", cursor: "pointer", color: "var(--status-error-text)", opacity: 0.7 }}
                  onClick={() => setHomes((prev) => prev.filter((x) => x !== h))}
                  title="Remove home"
                  aria-label={`Remove Claude home ${h}`}
                >
                  <Trash2 style={{ width: "11px", height: "11px" }} />
                </button>
              </div>
            ))}
            <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
              <input
                style={{ ...S.input, fontFamily: "var(--font-mono)", fontSize: "0.74rem" }}
                placeholder={"\\\\wsl.localhost\\<distro>\\home\\<user>\\.claude"}
                value={newHome}
                onChange={(e) => setNewHome(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { addHome(newHome); setNewHome(""); } }}
              />
              <button
                style={{ ...S.btn, flexShrink: 0, opacity: !newHome.trim() ? 0.5 : 1 }}
                disabled={!newHome.trim()}
                onClick={() => { addHome(newHome); setNewHome(""); }}
              >
                Add
              </button>
            </div>

            <div style={{ ...S.label, margin: "16px 0 6px" }}>Path mappings</div>
            {mappings.length === 0 && <p style={S.muted}>None — added automatically with detected WSL homes.</p>}
            {mappings.map((m, i) => (
              <div key={`${m.from}→${m.to}`} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.from} ↔ {m.to}
                </code>
                <button
                  style={{ background: "none", border: "none", padding: "3px", cursor: "pointer", color: "var(--status-error-text)", opacity: 0.7 }}
                  onClick={() => setMappings((prev) => prev.filter((_, idx) => idx !== i))}
                  title="Remove mapping"
                  aria-label={`Remove path mapping ${m.from}`}
                >
                  <Trash2 style={{ width: "11px", height: "11px" }} />
                </button>
              </div>
            ))}

            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "14px" }}>
              <button
                style={{ ...S.btn, opacity: !isDirty || saving ? 0.5 : 1, cursor: !isDirty || saving ? "not-allowed" : "pointer" }}
                onClick={save}
                disabled={!isDirty || saving}
              >
                {saving ? "Saving…" : "Save & Rescan"}
              </button>
              {isDirty && !saving && (
                <button
                  style={{ ...S.btn, background: "transparent" }}
                  onClick={() => { setHomes(savedHomes); setMappings(savedMappings); }}
                >
                  Discard
                </button>
              )}
              <button
                style={{ ...S.btn, background: "transparent", opacity: detecting ? 0.5 : 1 }}
                onClick={detectWsl}
                disabled={detecting}
              >
                {detecting ? "Detecting…" : "Detect WSL"}
              </button>
            </div>

            {wslHomes !== null && (
              <div style={{ marginTop: "14px", borderTop: "1px solid var(--border-subtle)", paddingTop: "12px" }}>
                {wslHomes.length === 0 && <p style={S.muted}>No WSL distros with a ~/.claude found (WSL missing, or distros stopped).</p>}
                {wslHomes.map(({ home, distro, state }) => (
                  <div key={`${distro}:${home}`} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {home || `${distro} — ${state === "Running" ? "no ~/.claude found" : "stopped (start it and detect again)"}`}
                    </code>
                    {home && (
                      <button
                        style={{ ...S.btn, padding: "2px 10px", fontSize: "0.7rem", opacity: homes.includes(home) ? 0.5 : 1, cursor: homes.includes(home) ? "default" : "pointer", flexShrink: 0 }}
                        disabled={homes.includes(home)}
                        onClick={() => addHome(home)}
                      >
                        {homes.includes(home) ? "Added" : "Add home + mapping"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
