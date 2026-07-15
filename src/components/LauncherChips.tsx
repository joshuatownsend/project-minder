"use client";

/**
 * LauncherChips — one-click "run this workflow" chips.
 *
 * A thin launcher on top of the task dispatcher: each chip dispatches a single
 * task (`POST /api/tasks`) rather than opening the full Swarm composer. Two
 * modes, driven by whether `projectPath` is supplied:
 *
 *  - Per-project (projectPath given): a chip click dispatches immediately,
 *    scoped to that project. Used as a strip on the project detail page.
 *  - Global (no projectPath): a chip click opens a project picker first, then
 *    dispatches. Used in the global row under the top bar.
 *
 * Chips come from two sources: the curated `LAUNCHER_WORKFLOWS` gallery and the
 * user's user-invocable skills (fetched from /api/skills).
 */

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { HelpCircle, Search } from "lucide-react";
import { useToast } from "./ToastProvider";
import { useHelp } from "./HelpProvider";
import { Modal } from "@/components/ui/modal";
import { inputStyle } from "./composer-fields";
import {
  LAUNCHER_WORKFLOWS,
  buildWorkflowDispatch,
  buildSkillDispatch,
  selectSkillChips,
  type LauncherDispatch,
  type SkillChip,
} from "@/lib/launchers/definitions";

interface LauncherChipsProps {
  /** When provided, chips dispatch directly against this project (no picker). */
  projectPath?: string;
  /** Display name for the toast confirmation. */
  projectName?: string;
  /** Optional leading label (e.g. "Quick Launch"). */
  label?: string;
}

/** A chip's click intent — resolved into a POST body once a project is known. */
interface ClickTarget {
  /** Stable id (matches the dispatched `metadata.launcherId`). */
  id: string;
  icon: string;
  label: string;
  title: string;
  build: (projectPath: string) => LauncherDispatch;
}

interface PickerProject {
  slug: string;
  name: string;
  path: string;
}

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  padding: "4px 10px",
  fontSize: "0.72rem",
  fontFamily: "var(--font-body)",
  color: "var(--text-secondary)",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "999px",
  cursor: "pointer",
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  transition: "color 0.1s, border-color 0.1s, opacity 0.1s",
};

export function LauncherChips({ projectPath, projectName, label }: LauncherChipsProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const { openHelp } = useHelp();

  const [skillChips, setSkillChips] = useState<SkillChip[]>([]);
  const [pending, setPending] = useState<string | null>(null);

  // Picker (global mode) state.
  const [pickTarget, setPickTarget] = useState<ClickTarget | null>(null);
  const [projects, setProjects] = useState<PickerProject[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");

  // Fetch user-invocable skills once; failure just yields curated chips only.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/skills", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: unknown) => {
        // GET /api/skills returns the SkillRow[] array directly (the route
        // unwraps loadSkillsResponse), not an object with a `data` property.
        setSkillChips(selectSkillChips(Array.isArray(d) ? (d as never[]) : []));
      })
      .catch(() => {
        /* offline / demo-empty / error — curated chips still render */
      });
    return () => ctrl.abort();
  }, []);

  const runDispatch = useCallback(
    async (target: ClickTarget, path: string, name?: string) => {
      const dispatch = target.build(path);
      setPending(dispatch.metadata.launcherId);
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: dispatch.title,
            description: dispatch.description,
            execution_mode: dispatch.execution_mode,
            risk_level: dispatch.risk_level,
            requires_approval: dispatch.requires_approval,
            metadata: dispatch.metadata,
          }),
        });

        if (res.status === 409) {
          showToast("Read-only in demo mode", "Launching tasks is disabled while demo mode is on.");
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          showToast("Couldn't launch", data.error ?? `Server error (${res.status})`);
          return;
        }

        showToast(`Launched · ${target.label}`, name ? `in ${name}` : undefined, {
          label: "View in Tasks",
          onClick: () => router.push("/tasks"),
        });
      } catch (err) {
        showToast("Couldn't launch", err instanceof Error ? err.message : "Unexpected error");
      } finally {
        setPending(null);
      }
    },
    [router, showToast],
  );

  const onChipClick = useCallback(
    (target: ClickTarget) => {
      if (projectPath) {
        void runDispatch(target, projectPath, projectName);
        return;
      }
      // Global mode: pick a project first.
      setPickerQuery("");
      setPickTarget(target);
    },
    [projectPath, projectName, runDispatch],
  );

  // Lazily load the project list the first time the picker opens.
  useEffect(() => {
    if (!pickTarget || projects.length > 0) return;
    const ctrl = new AbortController();
    fetch("/api/projects", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: { projects?: Array<{ slug: string; name: string; path: string }> }) => {
        setProjects(
          Array.isArray(d?.projects)
            ? d.projects.map((p) => ({ slug: p.slug, name: p.name, path: p.path }))
            : [],
        );
      })
      .catch(() => setProjects([]));
    return () => ctrl.abort();
  }, [pickTarget, projects.length]);

  const curatedTargets: ClickTarget[] = LAUNCHER_WORKFLOWS.map((wf) => ({
    id: wf.id,
    icon: wf.icon,
    label: wf.label,
    title: wf.description,
    build: (p) => buildWorkflowDispatch(wf, p),
  }));

  const skillTargets: ClickTarget[] = skillChips.map((s) => ({
    id: `skill:${s.slug}`,
    icon: "⚡",
    // The slug is the real slash token (matches CatalogActionStrip); `name`
    // may be display text, so it's only used as the tooltip.
    label: `/${s.slug}`,
    title: s.description ?? s.name ?? `Run the /${s.slug} skill on this project`,
    build: (p) => buildSkillDispatch(s, p),
  }));

  function renderChip(target: ClickTarget) {
    const busy = pending === target.id;
    return (
      <button
        key={target.id}
        type="button"
        disabled={pending !== null}
        title={target.title}
        onClick={() => onChipClick(target)}
        style={{ ...chipStyle, opacity: pending !== null && !busy ? 0.5 : 1, cursor: pending !== null ? "wait" : "pointer" }}
        onMouseEnter={(e) => {
          if (pending !== null) return;
          e.currentTarget.style.color = "var(--text-primary)";
          e.currentTarget.style.borderColor = "var(--border-default)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--text-secondary)";
          e.currentTarget.style.borderColor = "var(--border-subtle)";
        }}
      >
        <span aria-hidden>{target.icon}</span>
        {busy ? "Launching…" : target.label}
      </button>
    );
  }

  const filteredProjects = pickerQuery.trim()
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(pickerQuery.toLowerCase()) ||
          p.path.toLowerCase().includes(pickerQuery.toLowerCase()),
      )
    : projects;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
      {label && (
        <span
          style={{
            fontSize: "0.62rem",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      )}

      {curatedTargets.map((t) => renderChip(t))}

      {skillTargets.length > 0 && (
        <span aria-hidden style={{ width: "1px", height: "16px", background: "var(--border-subtle)", margin: "0 2px" }} />
      )}
      {skillTargets.map((t) => renderChip(t))}

      <button
        type="button"
        aria-label="About workflow launcher"
        title="About the workflow launcher"
        onClick={() => openHelp("workflow-launcher")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          padding: "2px",
        }}
      >
        <HelpCircle style={{ width: "13px", height: "13px" }} />
      </button>

      {/* Project picker (global mode only) */}
      <Modal
        open={pickTarget !== null}
        onClose={() => setPickTarget(null)}
        title={pickTarget ? `Launch "${pickTarget.label}" in…` : "Launch in…"}
        maxWidthClass="max-w-md"
      >
        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ position: "relative" }}>
            <Search
              style={{ position: "absolute", left: "8px", top: "50%", transform: "translateY(-50%)", width: "13px", height: "13px", color: "var(--text-muted)" }}
            />
            <input
              autoFocus
              style={{ ...inputStyle, paddingLeft: "28px" }}
              placeholder="Filter projects…"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px", maxHeight: "48vh", overflowY: "auto" }}>
            {filteredProjects.length === 0 && (
              <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", padding: "8px" }}>
                {projects.length === 0 ? "Loading projects…" : "No matching projects."}
              </span>
            )}
            {filteredProjects.map((p) => (
              <button
                key={p.slug}
                type="button"
                onClick={() => {
                  const target = pickTarget;
                  setPickTarget(null);
                  if (target) void runDispatch(target, p.path, p.name);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: "1px",
                  padding: "7px 9px",
                  background: "none",
                  border: "1px solid transparent",
                  borderRadius: "6px",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-elevated)";
                  e.currentTarget.style.borderColor = "var(--border-subtle)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.borderColor = "transparent";
                }}
              >
                <span style={{ fontSize: "0.82rem", color: "var(--text-primary)", fontWeight: 600 }}>{p.name}</span>
                <span style={{ fontSize: "0.66rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{p.path}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
