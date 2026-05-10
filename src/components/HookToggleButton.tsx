"use client";

import { useState } from "react";
import type { ToggleScope } from "@/lib/hookToggle";

interface Props {
  hookId: string;
  scope: ToggleScope;
  /** Required when scope === "local". */
  projectPath?: string;
  /** Whether the row is currently disabled (renders "enable" instead). */
  disabled: boolean;
  onToggled?: () => void;
}

/** Toggle button rendered next to a hook row. Callers are responsible for
 *  filtering rows to toggleable scopes (`user` and `local`); this component
 *  doesn't render for `plugin` or project-shared hooks. */
export function HookToggleButton({ hookId, scope, projectPath, disabled, onToggled }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (scope === "local" && !projectPath) return null;

  const action = disabled ? "enable" : "disable";

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/hooks/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, scope, hookId, projectPath }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      onToggled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "toggle failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={
        error
          ? `Toggle failed: ${error}`
          : disabled
            ? "Re-insert this hook into settings.json at its original position"
            : "Stash this hook — Claude Code will stop firing it until re-enabled"
      }
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: error ? "var(--error, #ef4444)" : disabled ? "var(--success, #22c55e)" : "var(--warning, #f59e0b)",
        background: "transparent",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 6px",
        cursor: pending ? "wait" : "pointer",
        opacity: pending ? 0.5 : 1,
        textTransform: "lowercase",
        letterSpacing: "0.04em",
      }}
    >
      {pending ? "…" : action}
    </button>
  );
}

