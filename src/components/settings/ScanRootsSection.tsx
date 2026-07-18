"use client";

import { useEffect, useState } from "react";
import type { MinderConfig } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";
import { ScanRootsEditor } from "@/components/ScanRootsEditor";
import { S } from "./styles";

interface WslDistroSuggestion {
  name: string;
  state: string;
  isDefault: boolean;
  suggestedRoots: string[];
  claudeHomes: string[];
}

interface WslDiscovery {
  available: boolean;
  distros: WslDistroSuggestion[];
}

export function ScanRootsSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const { showToast } = useToast();
  const [roots, setRoots] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [wsl, setWsl] = useState<WslDiscovery | null>(null);

  async function detectWsl() {
    setDetecting(true);
    try {
      const res = await fetch("/api/wsl");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setWsl(await res.json());
    } catch (e) {
      showToast("WSL detection failed", e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }

  const savedRoots = config
    ? (config.devRoots && config.devRoots.length > 0 ? config.devRoots : [config.devRoot])
    : null;

  useEffect(() => {
    if (savedRoots) setRoots(savedRoots);
    // Re-seed only when the persisted value changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(savedRoots)]);

  const isDirty = savedRoots !== null && JSON.stringify(roots) !== JSON.stringify(savedRoots);

  async function save() {
    setSaving(true);
    try {
      // PATCH /api/config validates the list and mirrors devRoot = roots[0].
      await onConfigChange({ devRoots: roots });
      // Force a rescan so the new roots show up without waiting out the 5-min
      // scan-cache TTL. Failure here is non-fatal: the config is saved and the
      // next natural rescan picks it up.
      try {
        const res = await fetch("/api/scan", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast("Scan roots saved", "Rescanning projects now");
      } catch {
        showToast(
          "Scan roots saved, but rescan failed",
          "New roots apply when the scan cache expires (up to 5 min) — or rescan from the dashboard"
        );
      }
    } catch {
      // onConfigChange already toasted the error; keep the draft for retry.
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Scan Roots</h2>
      <p style={S.desc}>
        Directories Project Minder scans for projects. Each immediate subdirectory of a root becomes a
        dashboard project. The first entry is the <strong>primary root</strong> — it determines the default
        dev-server base path and the header label. Add roots to monitor other drives or locations, e.g. a WSL
        distro via <code style={{ fontFamily: "var(--font-mono)" }}>{"\\\\wsl.localhost\\<distro>\\home\\<user>\\dev"}</code>.
      </p>

      <div style={S.card}>
        {config === null ? (
          <p style={S.muted}>Loading…</p>
        ) : (
          <>
            <ScanRootsEditor roots={roots} onChange={setRoots} />
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
                  onClick={() => savedRoots && setRoots(savedRoots)}
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

            {wsl !== null && (
              <div style={{ marginTop: "14px", borderTop: "1px solid var(--border-subtle)", paddingTop: "12px" }}>
                {!wsl.available && (
                  <p style={S.muted}>WSL is not available on this machine.</p>
                )}
                {wsl.available && wsl.distros.length === 0 && (
                  <p style={S.muted}>No WSL distros found.</p>
                )}
                {wsl.distros.map((d) => (
                  <div key={d.name} style={{ marginBottom: "10px" }}>
                    <div style={{ ...S.label, fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                      {d.name}
                      <span style={{ ...S.badge, marginLeft: "8px" }}>{d.state}</span>
                    </div>
                    {d.state !== "Running" && (
                      <p style={{ ...S.muted, marginTop: "2px" }}>
                        Start the distro (open a WSL terminal) and detect again to find its dev directories —
                        Minder never starts a stopped distro itself.
                      </p>
                    )}
                    {d.state === "Running" && d.suggestedRoots.length === 0 && (
                      <p style={{ ...S.muted, marginTop: "2px" }}>No <code>~/dev</code> directory found in this distro.</p>
                    )}
                    {d.suggestedRoots.map((root) => {
                      const already = roots.includes(root);
                      return (
                        <div key={root} style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {root}
                          </code>
                          <button
                            style={{ ...S.btn, padding: "2px 10px", fontSize: "0.7rem", opacity: already ? 0.5 : 1, cursor: already ? "default" : "pointer", flexShrink: 0 }}
                            disabled={already}
                            onClick={() => setRoots((prev) => (prev.includes(root) ? prev : [...prev, root]))}
                          >
                            {already ? "Added" : "Add as scan root"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
                <p style={{ ...S.muted, marginTop: "4px" }}>
                  Added roots take effect after <strong>Save &amp; Rescan</strong>. See the WSL Integration help
                  page for git-over-UNC notes.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
