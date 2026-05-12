"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { MemoryFileEntry } from "@/lib/types";
import type {
  TriageEntry,
  TriageRecommendation,
  TriageReport,
} from "@/lib/memory/triageScorer";
import { formatKB } from "@/lib/utils";
import { Chip } from "./ui/chip";

interface ManagedRow {
  name: string;
  absPath: string;
  mtimeMs: number;
  sizeBytes: number;
  projectSlug: string;
  projectName: string;
}

interface TrashedRow extends ManagedRow {
  autoDeleteAt: string;
}

interface TriageResponse {
  report: TriageReport;
  archived: ManagedRow[];
  trashed: TrashedRow[];
}

type ActionId = "archive" | "delete" | "keep" | "unsuppress" | "restore-archive" | "restore-trash";

const KEEP_OPTIONS = [
  { days: 7, label: "Keep 7d" },
  { days: 30, label: "Keep 30d" },
  { days: 90, label: "Keep 90d" },
];

export function MemoryTriage() {
  const [data, setData] = useState<TriageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch("/api/memory/triage", { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as TriageResponse;
      setData(json);
      setError(null);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to load triage");
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  async function act(
    rowKey: string,
    body: { action: ActionId; projectSlug: string; fileName: string; days?: number },
  ) {
    setPending((p) => {
      const next = new Set(p);
      next.add(rowKey);
      return next;
    });
    try {
      const r = await fetch("/api/memory/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(`${body.action} failed: ${extractErrorCode(j, r.status)}`);
        return;
      }
      await reload();
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(rowKey);
        return next;
      });
      setConfirming(null);
    }
  }

  const groups = useMemo(() => {
    const out: Record<TriageRecommendation, TriageEntry[]> = {
      delete: [],
      archive: [],
      keep: [],
    };
    if (!data) return out;
    for (const c of data.report.candidates) out[c.recommendation].push(c);
    return out;
  }, [data]);

  if (error) {
    return (
      <p style={{ padding: "40px 0", color: "var(--status-error-text, var(--accent))" }}>
        {error}
      </p>
    );
  }
  if (!data) {
    return <p style={{ padding: "40px 0", color: "var(--text-muted)" }}>Loading</p>;
  }

  const { report, archived, trashed } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <SummaryBanner report={report} archivedCount={archived.length} trashedCount={trashed.length} />

      {groups.delete.length > 0 && (
        <Section
          title={`Consider deletion · ${groups.delete.length}`}
          subtitle="Stale entries with broken refs or no MEMORY.md backref. Soft-deletes are recoverable for 30 days."
          accent="var(--status-error-text, var(--accent))"
        >
          {groups.delete.map((t) => (
            <CandidateRow
              key={t.entry.absPath}
              triage={t}
              pending={pending.has(t.entry.absPath)}
              confirming={confirming === t.entry.absPath}
              onArchive={() => act(t.entry.absPath, actionBody("archive", t.entry))}
              onConfirmDelete={() => setConfirming(t.entry.absPath)}
              onCommitDelete={() => act(t.entry.absPath, actionBody("delete", t.entry))}
              onCancelDelete={() => setConfirming(null)}
              onKeep={(days) => act(t.entry.absPath, actionBody("keep", t.entry, days))}
            />
          ))}
        </Section>
      )}

      {groups.archive.length > 0 && (
        <Section
          title={`Archive candidates · ${groups.archive.length}`}
          subtitle="Never read, or unread for 90+ days. Archive moves them aside; you can restore from the section below."
          accent="var(--status-warn, var(--accent))"
        >
          {groups.archive.map((t) => (
            <CandidateRow
              key={t.entry.absPath}
              triage={t}
              pending={pending.has(t.entry.absPath)}
              confirming={confirming === t.entry.absPath}
              onArchive={() => act(t.entry.absPath, actionBody("archive", t.entry))}
              onConfirmDelete={() => setConfirming(t.entry.absPath)}
              onCommitDelete={() => act(t.entry.absPath, actionBody("delete", t.entry))}
              onCancelDelete={() => setConfirming(null)}
              onKeep={(days) => act(t.entry.absPath, actionBody("keep", t.entry, days))}
            />
          ))}
        </Section>
      )}

      {report.suppressed.length > 0 && (
        <Section
          title={`Suppressed · ${report.suppressed.length}`}
          subtitle="Hidden by a recent Keep action. Lift the hold to re-evaluate."
          accent="var(--text-muted)"
        >
          {report.suppressed.map((t) => (
            <SuppressedRow
              key={t.entry.absPath}
              triage={t}
              pending={pending.has(t.entry.absPath)}
              onLift={() => act(t.entry.absPath, actionBody("unsuppress", t.entry))}
            />
          ))}
        </Section>
      )}

      {archived.length > 0 && (
        <Section
          title={`Archived · ${archived.length}`}
          subtitle="Moved out of the live memory dir. Restore at any time."
          accent="var(--text-muted)"
        >
          {archived.map((f) => (
            <ManagedRowView
              key={f.absPath}
              row={f}
              pending={pending.has(f.absPath)}
              actionLabel="Restore"
              onAction={() =>
                act(f.absPath, {
                  action: "restore-archive",
                  projectSlug: f.projectSlug,
                  fileName: f.name,
                })
              }
            />
          ))}
        </Section>
      )}

      {trashed.length > 0 && (
        <Section
          title={`Trash · ${trashed.length}`}
          subtitle="Soft-deleted within the last 30 days. Restore to undo; otherwise the file is permanently removed when its window expires."
          accent="var(--status-error-text, var(--accent))"
        >
          {trashed.map((f) => (
            <ManagedRowView
              key={f.absPath}
              row={f}
              pending={pending.has(f.absPath)}
              actionLabel="Restore"
              autoDeleteAt={f.autoDeleteAt}
              onAction={() =>
                act(f.absPath, {
                  action: "restore-trash",
                  projectSlug: f.projectSlug,
                  fileName: f.name,
                })
              }
            />
          ))}
        </Section>
      )}

      {report.candidates.length === 0 && report.suppressed.length === 0 && archived.length === 0 && trashed.length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", textAlign: "center", padding: "40px 0" }}>
          Nothing to triage. {report.total > 0 ? `Inspected ${report.total} auto-scope memor${report.total === 1 ? "y" : "ies"}.` : "No agent-authored memory files yet."}
        </p>
      )}
    </div>
  );
}

function actionBody(action: ActionId, entry: MemoryFileEntry, days?: number) {
  return {
    action,
    projectSlug: entry.projectSlug ?? "",
    fileName: entry.displayName,
    ...(days !== undefined ? { days } : {}),
  };
}

function extractErrorCode(json: unknown, status: number): string {
  const err = (json as { error?: unknown } | null)?.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return `HTTP ${status}`;
}

function SummaryBanner({
  report,
  archivedCount,
  trashedCount,
}: {
  report: TriageReport;
  archivedCount: number;
  trashedCount: number;
}) {
  const deleteCount = report.candidates.filter((c) => c.recommendation === "delete").length;
  const archiveCount = report.candidates.filter((c) => c.recommendation === "archive").length;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "12px",
        padding: "12px 16px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius)",
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
        Inspected {report.total} auto-scope memor{report.total === 1 ? "y" : "ies"}
      </span>
      <span style={{ flex: 1 }} />
      <Chip
        label={`${deleteCount} delete`}
        color="var(--status-error-text, var(--accent))"
        muted={deleteCount === 0}
      />
      <Chip
        label={`${archiveCount} archive`}
        color="var(--status-warn, var(--accent))"
        muted={archiveCount === 0}
      />
      <Chip
        label={`${formatKB(report.bytesRecoverable)} reclaimable`}
        muted={report.bytesRecoverable === 0}
      />
      <Chip label={`${archivedCount} archived`} muted={archivedCount === 0} />
      <Chip
        label={`${trashedCount} in trash`}
        color="var(--status-error-text, var(--accent))"
        muted={trashedCount === 0}
      />
    </div>
  );
}

function Section({
  title,
  subtitle,
  accent,
  children,
}: {
  title: string;
  subtitle: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <h2
          style={{
            margin: 0,
            fontSize: "0.78rem",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: accent,
          }}
        >
          {title}
        </h2>
        <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)" }}>{subtitle}</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>{children}</div>
    </section>
  );
}

function CandidateRow({
  triage,
  pending,
  confirming,
  onArchive,
  onConfirmDelete,
  onCommitDelete,
  onCancelDelete,
  onKeep,
}: {
  triage: TriageEntry;
  pending: boolean;
  confirming: boolean;
  onArchive: () => void;
  onConfirmDelete: () => void;
  onCommitDelete: () => void;
  onCancelDelete: () => void;
  onKeep: (days: number) => void;
}) {
  const { entry, reasons } = triage;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "10px 12px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "baseline" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--text-primary)" }}>
          {entry.displayName}
        </span>
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
          {entry.projectName ?? entry.projectSlug ?? "—"}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
          {formatKB(entry.sizeBytes)} · modified {formatDistanceToNow(entry.mtimeMs, { addSuffix: true })}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {reasons.map((r) => (
          <Chip key={r} label={r} muted />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
        {confirming ? (
          <>
            <span style={{ fontSize: "0.72rem", color: "var(--status-error-text, var(--accent))" }}>
              Delete this memory? It is recoverable from Trash for 30 days.
            </span>
            <span style={{ flex: 1 }} />
            <ActionButton label="Confirm delete" onClick={onCommitDelete} disabled={pending} variant="danger" />
            <ActionButton label="Cancel" onClick={onCancelDelete} disabled={pending} />
          </>
        ) : (
          <>
            <ActionButton label="Archive" onClick={onArchive} disabled={pending} />
            <ActionButton label="Delete…" onClick={onConfirmDelete} disabled={pending} variant="danger" />
            <span style={{ flex: 1 }} />
            {KEEP_OPTIONS.map((opt) => (
              <ActionButton
                key={opt.days}
                label={opt.label}
                onClick={() => onKeep(opt.days)}
                disabled={pending}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SuppressedRow({
  triage,
  pending,
  onLift,
}: {
  triage: TriageEntry;
  pending: boolean;
  onLift: () => void;
}) {
  const { entry, suppressedUntil } = triage;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius)",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text-primary)" }}>
        {entry.displayName}
      </span>
      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
        {entry.projectName ?? entry.projectSlug ?? "—"}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
        until {suppressedUntil ? suppressedUntil.slice(0, 10) : "—"}
      </span>
      <ActionButton label="Lift hold" onClick={onLift} disabled={pending} />
    </div>
  );
}

function ManagedRowView({
  row,
  pending,
  actionLabel,
  autoDeleteAt,
  onAction,
}: {
  row: ManagedRow;
  pending: boolean;
  actionLabel: string;
  autoDeleteAt?: string;
  onAction: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius)",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text-primary)" }}>
        {row.name}
      </span>
      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{row.projectName}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
        {formatKB(row.sizeBytes)} · moved {formatDistanceToNow(row.mtimeMs, { addSuffix: true })}
        {autoDeleteAt ? ` · auto-deletes ${autoDeleteAt.slice(0, 10)}` : ""}
      </span>
      <ActionButton label={actionLabel} onClick={onAction} disabled={pending} />
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  variant = "default",
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  variant?: "default" | "danger";
}) {
  const color =
    variant === "danger" ? "var(--status-error-text, var(--accent))" : "var(--text-primary)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        padding: "4px 10px",
        background: "transparent",
        border: `1px solid ${variant === "danger" ? "var(--status-error-text, var(--border-default))" : "var(--border-default)"}`,
        borderRadius: "var(--radius)",
        color,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
