"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureFlagKey, MinderConfig } from "@/lib/types";
import { getFlag } from "@/lib/featureFlags";
import {
  MS_PER_CHUNK,
  coveragePercent,
  formatCount,
  formatEta,
  formatPercent,
  observedMsPerChunk,
  runtimeState,
  shouldContinue,
  type BackfillPass,
} from "@/lib/embeddings/progress";
import { Toggle } from "./Toggle";
import { S } from "./styles";

/**
 * Semantic search: the flag, the index coverage, and the button that fills it.
 *
 * Embedding the whole corpus is ~40 minutes of local CPU, so the backfill is
 * driven from here in bounded passes rather than by a background loop the user
 * never agreed to. Each pass is one POST; the driver keeps going until the
 * corpus is covered, the user presses Stop, or a pass stops making progress.
 *
 * Deliberately does not import from `backfill.ts` — that module is
 * `server-only`, and pulling it into this bundle would break the build. The
 * per-pass budget is left to the server by omitting `chunks`.
 */

interface EmbeddingStatus {
  enabled: boolean;
  indexReady: boolean;
  available: boolean;
  reason?: string | null;
  model: string;
  modelCacheDir?: string;
  modelCachePresent?: boolean;
  total: number;
  embedded: number;
  remaining: number;
}

/** Only reached for a 200 that stopped early; 409/503 arrive as thrown errors. */
function describeStop(code: string): string | null {
  switch (code) {
    case "nothing-to-do":
      return null;
    case "error":
      return "A pass failed partway through. Everything embedded before the failure was kept — press Build again to resume.";
    case "no-model":
      return "The embedding runtime could not be loaded.";
    case "no-chunk-corpus":
      return "The chunked search index has not been built yet. Restart Minder so the migration runs.";
    default:
      return `Stopped: ${code}`;
  }
}

export function SemanticSearchSection({ config, saving, onToggle }: {
  config: MinderConfig | null;
  saving: ReadonlySet<FeatureFlagKey>;
  onToggle: (key: FeatureFlagKey, next: boolean) => void;
}) {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [passes, setPasses] = useState(0);
  const [embeddedThisRun, setEmbeddedThisRun] = useState(0);
  const [rate, setRate] = useState<number | null>(null);

  // Refs, not state: the driver loop reads these between awaits, and a state
  // value captured in the closure would never see the user's Stop.
  const stopRequested = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Navigating away ends the run. Without this the loop would keep POSTing
      // against a page nobody is watching, with no way left to stop it.
      stopRequested.current = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/embeddings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as EmbeddingStatus;
      if (!mounted.current) return;
      setStatus(body);
      setLoadError(null);
    } catch (e: unknown) {
      if (!mounted.current) return;
      // A failed read is not "0 chunks embedded" — clear the stale numbers so
      // the panel can't show a confident, wrong coverage figure.
      setStatus(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flagOn = getFlag(config?.featureFlags, "semanticSearch", false);
  const flagSaving = saving.has("semanticSearch");
  const autoOn = getFlag(config?.featureFlags, "semanticAutoBackfill", false);
  const autoSaving = saving.has("semanticAutoBackfill");

  async function runBackfill() {
    stopRequested.current = false;
    setRunning(true);
    setRunError(null);
    setPasses(0);
    setEmbeddedThisRun(0);

    let previousRemaining: number | null = null;
    try {
      for (;;) {
        const res = await fetch("/api/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No `chunks`: the server's own default is the measured-good budget.
          body: "{}",
        });
        const body = (await res.json().catch(() => null)) as (BackfillPass & { error?: string }) | null;
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (!body) throw new Error("malformed response from /api/embeddings");
        if (!mounted.current) return;

        // `body.embedded` counts THIS pass; corpus-wide progress is
        // total - remaining. Mixing the two pins the bar at one pass forever.
        setStatus((prev) =>
          prev
            ? { ...prev, total: body.total, remaining: body.remaining, embedded: body.total - body.remaining }
            : prev
        );
        setPasses((n) => n + 1);
        setEmbeddedThisRun((n) => n + body.embedded);
        const observed = observedMsPerChunk(body);
        if (observed !== null) setRate(observed);

        const keepGoing = shouldContinue(body, previousRemaining);
        previousRemaining = body.remaining;

        if (!keepGoing) {
          const message = body.stoppedBecause ? describeStop(body.stoppedBecause) : null;
          if (message) setRunError(message);
          break;
        }
        if (stopRequested.current) break;
      }
    } catch (e: unknown) {
      if (mounted.current) setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) {
        setRunning(false);
        // Re-read authoritative counts; the loop's were per-pass echoes.
        void refresh();
      }
    }
  }

  const total = status?.total ?? 0;
  const embedded = status?.embedded ?? 0;
  const remaining = status?.remaining ?? 0;
  const pct = coveragePercent(embedded, total);
  const runtime = runtimeState(status?.available ?? false, status?.reason);
  const indexReady = status?.indexReady ?? false;
  const canBuild = flagOn && indexReady && !loadError && !running;

  return (
    <div>
      <h2 style={S.sectionTitle}>Semantic Search</h2>
      <p style={S.desc}>
        Matches sessions by meaning rather than by keyword, as a third retriever fused into session
        search alongside full-text and title matching. Everything runs locally — a small sentence
        embedding model on this machine, with no network calls at query time and nothing sent
        anywhere. Off by default because the first run downloads roughly 80&nbsp;MB and building the
        index costs real CPU time.
      </p>

      <div style={S.card}>
        <div style={{ ...S.row, background: "transparent", border: "none", padding: 0, marginBottom: "12px" }}>
          <div style={{ minWidth: 0 }}>
            <div style={S.label}>Enable semantic search</div>
            <div style={{ ...S.muted, marginTop: "3px" }}>
              Turning this on is the consent for the model download. Search keeps working either
              way — without it, results come from full-text and title matching alone.
            </div>
          </div>
          <Toggle
            label="Enable semantic search"
            value={flagOn}
            disabled={flagSaving}
            onChange={(v) => onToggle("semanticSearch", v)}
          />
        </div>

        <div style={{ ...S.row, background: "transparent", border: "none", padding: 0, marginBottom: "12px" }}>
          <div style={{ minWidth: 0, opacity: flagOn ? 1 : 0.55 }}>
            <div style={S.label}>Keep the index current automatically</div>
            <div style={{ ...S.muted, marginTop: "3px" }}>
              {flagOn ? (
                <>
                  Tops up the index on the background task tick, so sessions indexed after the last
                  build become searchable without pressing Build again. Runs only while no agent
                  task is running, about {formatCount(250)} chunks at a time, and stands down for ten
                  minutes once there is nothing left to embed.
                </>
              ) : (
                <>Requires semantic search above — on its own it has nothing to keep current.</>
              )}
            </div>
          </div>
          <Toggle
            label="Keep the embedding index current automatically"
            value={autoOn && flagOn}
            disabled={autoSaving || !flagOn}
            onChange={(v) => onToggle("semanticAutoBackfill", v)}
          />
        </div>

        <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "12px" }}>
          {loading && !status && <div style={S.muted}>Reading index coverage…</div>}

          {loadError && (
            <div style={{ ...S.muted, color: "var(--danger, var(--text-secondary))" }}>
              Couldn&rsquo;t read embedding status: {loadError}. No coverage figure is shown because
              none was read.
            </div>
          )}

          {status && !indexReady && (
            <div style={{ ...S.muted, color: "var(--warning, var(--text-secondary))" }}>
              {status.reason ?? "The search index is not ready."}
            </div>
          )}

          {status && indexReady && (
            <>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" }}>
                <div style={S.label}>Index coverage</div>
                <div style={{ ...S.muted, fontFamily: "var(--font-mono)" }}>
                  {formatCount(embedded)} / {formatCount(total)} chunks &middot;{" "}
                  {formatPercent(embedded, total)}
                </div>
              </div>

              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                aria-label="Embedding index coverage"
                style={{
                  height: "6px",
                  width: "100%",
                  marginTop: "8px",
                  borderRadius: "9999px",
                  background: "var(--border-subtle)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: "100%",
                    // scaleX rather than an animated width: a transform is
                    // composited, so a pass landing every ~30 s doesn't force
                    // layout on the whole Settings page to move a 6 px bar.
                    transform: `scaleX(${pct / 100})`,
                    transformOrigin: "left",
                    background: remaining === 0 ? "var(--success, var(--info))" : "var(--info)",
                    transition: "transform 0.3s",
                  }}
                />
              </div>

              <div style={{ ...S.muted, marginTop: "8px" }}>
                {remaining === 0 && total > 0 ? (
                  <>
                    Every chunk is embedded. New sessions add chunks as they&rsquo;re indexed
                    {autoOn && flagOn
                      ? " — those get picked up automatically on the background tick."
                      : " — run a build again to cover them."}
                  </>
                ) : (
                  <>
                    {formatCount(remaining)} chunks left to embed &mdash;{" "}
                    {formatEta(remaining, rate ?? MS_PER_CHUNK)}
                    {rate === null && " at the reference rate"}.
                  </>
                )}
              </div>

              {running && (
                <div style={{ ...S.muted, marginTop: "4px" }}>
                  Running &mdash; {formatCount(passes)} {passes === 1 ? "pass" : "passes"},{" "}
                  {formatCount(embeddedThisRun)} embedded this run. Leaving this page stops the run.
                </div>
              )}

              {runError && (
                <div style={{ ...S.muted, marginTop: "6px", color: "var(--danger, var(--text-secondary))" }}>
                  {runError}
                </div>
              )}

              <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
                {!running ? (
                  <button
                    type="button"
                    onClick={() => void runBackfill()}
                    disabled={!canBuild || remaining === 0}
                    style={{
                      ...S.btn,
                      cursor: canBuild && remaining > 0 ? "pointer" : "not-allowed",
                      opacity: canBuild && remaining > 0 ? 1 : 0.5,
                    }}
                  >
                    {embedded > 0 ? "Resume build" : "Build index"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      stopRequested.current = true;
                    }}
                    style={S.btn}
                  >
                    Stop after this pass
                  </button>
                )}
                <button type="button" onClick={() => void refresh()} disabled={loading} style={S.btn}>
                  Refresh
                </button>
              </div>

              {!flagOn && (
                <div style={{ ...S.muted, marginTop: "8px" }}>
                  Enable semantic search above before building the index.
                </div>
              )}
            </>
          )}

          {status && (
            <div style={{ ...S.muted, marginTop: "14px", borderTop: "1px solid var(--border-subtle)", paddingTop: "10px" }}>
              <div>
                <span style={S.label}>Model</span>{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>{status.model}</span>
              </div>
              {status.modelCacheDir && (
                <div style={{ marginTop: "3px" }}>
                  Cached in <span style={{ fontFamily: "var(--font-mono)" }}>{status.modelCacheDir}</span>{" "}
                  {status.modelCachePresent
                    ? "— model files are already on disk."
                    : "— not downloaded yet; the first pass fetches about 80 MB."}
                </div>
              )}
              <div style={{ marginTop: "3px" }}>
                {runtime === "failed" ? (
                  <span style={{ color: "var(--danger, var(--text-secondary))" }}>
                    Runtime unavailable: {status.reason}
                  </span>
                ) : runtime === "ready" ? (
                  "Runtime loaded and ready."
                ) : (
                  // Not an error: nothing has asked the model to load since the
                  // server started, which is the normal state after a restart.
                  "Runtime not loaded yet — it loads on the first search or build."
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
