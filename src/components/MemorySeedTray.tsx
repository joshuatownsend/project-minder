"use client";

import { useEffect, useMemo, useState } from "react";
import type { SeedCandidate } from "@/lib/types";
import { Chip } from "./ui/chip";
import { MemorySeedDiff } from "./MemorySeedDiff";

interface AnchorOption {
  slug: string;
  name: string;
  path: string;
}

interface SeedResponse {
  candidates: SeedCandidate[];
  anchorOptions: AnchorOption[];
}

interface PromoteResult {
  fileName: string;
  ok: boolean;
  error?: unknown;
}

type Action = "skip" | "create" | "overwrite";

const TYPE_COLOR: Record<SeedCandidate["type"], string> = {
  user: "var(--accent)",
  feedback: "var(--status-warn, var(--accent))",
  project: "var(--status-success, var(--accent))",
  reference: "var(--text-muted)",
};

export function MemorySeedTray() {
  const [data, setData] = useState<SeedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anchorPath, setAnchorPath] = useState<string>("");
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<PromoteResult[] | null>(null);

  async function reload(anchor: string, signal?: AbortSignal) {
    try {
      const url = anchor ? `/api/memory/seed?anchor=${encodeURIComponent(anchor)}` : "/api/memory/seed";
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as SeedResponse;
      setData(json);
      // Seed default actions: skip if conflict (user must explicitly choose),
      // create otherwise. The user toggles per row.
      const nextActions: Record<string, Action> = {};
      const nextBodies: Record<string, string> = {};
      for (const c of json.candidates) {
        nextActions[c.fileName] = c.conflict ? "skip" : "create";
        nextBodies[c.fileName] = c.body;
      }
      setActions(nextActions);
      setBodies(nextBodies);
      setError(null);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to load seed candidates");
    }
  }

  useEffect(() => {
    const ctrl = new AbortController();
    reload(anchorPath, ctrl.signal);
    return () => ctrl.abort();
  }, [anchorPath]);

  const candidates = data?.candidates ?? [];
  const anchorOptions = data?.anchorOptions ?? [];
  const userScopeNeedsAnchor = candidates.some((c) => c.scope === "user") && !anchorPath;

  const counts = useMemo(() => {
    let create = 0;
    let overwrite = 0;
    let skip = 0;
    let blocked = 0;
    for (const c of candidates) {
      const a = actions[c.fileName] ?? "skip";
      if (c.scope === "user" && !anchorPath) {
        blocked++;
        continue;
      }
      if (a === "create") create++;
      else if (a === "overwrite") overwrite++;
      else skip++;
    }
    return { create, overwrite, skip, blocked };
  }, [candidates, actions, anchorPath]);

  async function promote() {
    setBusy(true);
    const payload = candidates
      .map((c) => {
        const action = actions[c.fileName] ?? "skip";
        if (action === "skip") return null;
        // Skip user-scope rows with no anchor -- the server would reject them.
        if (c.scope === "user" && !anchorPath) return null;
        const targetProjectPath = c.scope === "per-project" ? c.targetProjectPath! : anchorPath;
        return {
          fileName: c.fileName,
          targetProjectPath,
          body: bodies[c.fileName] ?? c.body,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    try {
      const r = await fetch("/api/memory/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates: payload }),
      });
      const json = (await r.json()) as { results: PromoteResult[] };
      setLastRun(json.results);
      // Refresh so promoted rows pick up their conflict state (now they exist).
      reload(anchorPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Promote failed");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <p style={{ padding: "40px 0", color: "var(--accent)" }}>{error}</p>;
  }
  if (!data) {
    return <p style={{ padding: "40px 0", color: "var(--text-muted)" }}>Loading</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "14px",
          alignItems: "center",
          padding: "10px 14px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          fontSize: "0.72rem",
        }}
      >
        <span style={{ color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Anchor project
        </span>
        <select
          value={anchorPath}
          onChange={(e) => setAnchorPath(e.target.value)}
          style={{
            padding: "5px 10px",
            background: "var(--bg-elevated)",
            border: `1px solid ${userScopeNeedsAnchor ? "var(--accent)" : "var(--border-subtle)"}`,
            borderRadius: "var(--radius)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-body)",
            fontSize: "0.72rem",
          }}
        >
          <option value="">— pick an anchor for user-scope seeds —</option>
          {anchorOptions.map((p) => (
            <option key={p.slug} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <span>
          Promote plan: <strong>{counts.create}</strong> create
          {counts.overwrite > 0 && (
            <>, <strong style={{ color: "var(--accent)" }}>{counts.overwrite}</strong> overwrite</>
          )}, {counts.skip} skip
          {counts.blocked > 0 && (
            <>, <span style={{ color: "var(--accent)" }}>{counts.blocked} need anchor</span></>
          )}
        </span>
        <button
          onClick={promote}
          disabled={busy || counts.create + counts.overwrite === 0}
          style={{
            marginLeft: "auto",
            padding: "6px 14px",
            fontSize: "0.72rem",
            fontFamily: "var(--font-body)",
            background: busy ? "var(--bg-elevated)" : "var(--accent-bg)",
            color: "var(--accent)",
            border: "1px solid var(--accent-border)",
            borderRadius: "var(--radius)",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Promoting…" : `Promote ${counts.create + counts.overwrite} files`}
        </button>
      </div>

      {lastRun && (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            fontSize: "0.72rem",
          }}
        >
          Last run: {lastRun.filter((r) => r.ok).length} written, {lastRun.filter((r) => !r.ok).length} failed.
          {lastRun.filter((r) => !r.ok).map((r) => (
            <div key={r.fileName} style={{ color: "var(--accent)", marginTop: "4px" }}>
              {r.fileName}: {JSON.stringify(r.error)}
            </div>
          ))}
        </div>
      )}

      {candidates.map((c) => (
        <SeedRow
          key={c.fileName}
          candidate={c}
          action={actions[c.fileName] ?? "skip"}
          body={bodies[c.fileName] ?? c.body}
          anchorPath={anchorPath}
          onAction={(a) => setActions((prev) => ({ ...prev, [c.fileName]: a }))}
          onBody={(b) => setBodies((prev) => ({ ...prev, [c.fileName]: b }))}
        />
      ))}
    </div>
  );
}

function SeedRow({
  candidate,
  action,
  body,
  anchorPath,
  onAction,
  onBody,
}: {
  candidate: SeedCandidate;
  action: Action;
  body: string;
  anchorPath: string;
  onAction: (a: Action) => void;
  onBody: (b: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [editing, setEditing] = useState(false);
  const blocked = candidate.scope === "user" && !anchorPath;
  const targetPath =
    candidate.scope === "per-project"
      ? candidate.targetProjectPath!
      : anchorPath || "(pick anchor)";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "12px 14px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        opacity: blocked ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
          {candidate.fileName}
        </span>
        <Chip label={candidate.type} color={TYPE_COLOR[candidate.type]} />
        <Chip label={candidate.scope} muted />
        {candidate.conflict && (
          <Chip label="EXISTS" color="var(--accent)" title={candidate.conflict.existingPath} />
        )}
        {candidate.conflict?.existingIsSeeded && (
          <Chip label="prior seed" muted title="Existing file was created by a prior seed run" />
        )}
        <span style={{ marginLeft: "auto", fontSize: "0.66rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          → {targetPath}
        </span>
      </div>

      <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
        {candidate.preview}
      </div>

      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
        <ActionButton label="Skip" active={action === "skip"} onClick={() => onAction("skip")} />
        <ActionButton
          label={candidate.conflict ? "Create (rejected)" : "Create"}
          active={action === "create"}
          disabled={!!candidate.conflict || blocked}
          onClick={() => onAction("create")}
        />
        <ActionButton
          label="Overwrite"
          active={action === "overwrite"}
          disabled={!candidate.conflict || blocked}
          variant="warn"
          onClick={() => onAction("overwrite")}
        />
        {candidate.conflict && (
          <button
            onClick={() => setShowDiff((v) => !v)}
            style={{
              padding: "4px 10px",
              fontSize: "0.66rem",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
              color: "var(--text-secondary)",
            }}
          >
            {showDiff ? "Hide diff" : "Show 3-way diff"}
          </button>
        )}
        <button
          onClick={() => setEditing((v) => !v)}
          style={{
            padding: "4px 10px",
            fontSize: "0.66rem",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            cursor: "pointer",
            color: "var(--text-secondary)",
          }}
        >
          {editing ? "Hide edit" : "Edit before promote"}
        </button>
        <span style={{ marginLeft: "auto", fontSize: "0.62rem", color: "var(--text-muted)" }}>
          {candidate.provenance.join(" · ")}
        </span>
      </div>

      {showDiff && candidate.conflict && (
        <MemorySeedDiff existing={candidate.conflict.existingBody} proposed={body} />
      )}
      {editing && (
        <textarea
          value={body}
          onChange={(e) => onBody(e.target.value)}
          rows={Math.min(20, body.split("\n").length + 1)}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            padding: "8px 10px",
            color: "var(--text-primary)",
            width: "100%",
            resize: "vertical",
          }}
        />
      )}
    </div>
  );
}

function ActionButton({
  label,
  active,
  disabled,
  variant,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  variant?: "warn";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        fontSize: "0.66rem",
        fontFamily: "var(--font-body)",
        background: active
          ? variant === "warn"
            ? "var(--accent-bg)"
            : "var(--accent-bg)"
          : "var(--bg-surface)",
        color: active ? "var(--accent)" : disabled ? "var(--text-muted)" : "var(--text-secondary)",
        border: `1px solid ${active ? "var(--accent-border)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
