"use client";

import { Pill, inlineCode, commandPreview, fileBasename } from "./config/primitives";
import { HookToggleButton } from "./HookToggleButton";
import type { DisabledHookEntry } from "@/lib/hookToggle";

/** Walk up two segments from a settings file path
 *  (`<root>/.claude/settings.local.json` → `<root>`). String-only because
 *  Node's `path` module isn't safe to import in a browser bundle. */
function projectRootFromSettings(settingsPath: string): string {
  const parts = settingsPath.replace(/\\/g, "/").split("/");
  return parts.slice(0, -2).join("/");
}

interface Props {
  entries: DisabledHookEntry[];
  loading: boolean;
  error: string | null;
  /** Called after a successful re-enable so the parent can refresh both
   *  active hooks and disabled stash lists. */
  onChanged: () => void;
}

/** "Disabled (N)" section under the active-hooks list. Sourced from the
 *  ~/.claude/.minder/disabled-hooks.json sidecar. */
export function DisabledHooksSection({ entries, loading, error, onChanged }: Props) {
  if (loading || (entries.length === 0 && !error)) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
      <h2
        style={{
          fontSize: "0.65rem",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
          margin: 0,
        }}
      >
        Disabled ({entries.length})
      </h2>

      {error && (
        <div
          style={{
            padding: "6px 10px",
            background: "var(--error-bg, #2a0000)",
            borderRadius: "var(--radius)",
            fontSize: "0.72rem",
            color: "var(--error, #f87171)",
          }}
        >
          {error}
        </div>
      )}

      <div>
        {entries.map((e) => (
          <div
            key={e.hookId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "7px 0",
              borderBottom: "1px solid var(--border-subtle)",
              opacity: 0.85,
            }}
          >
            <Pill tone="info">{e.event}</Pill>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "0.72rem",
                display: "inline-flex",
                gap: "6px",
                alignItems: "center",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              {e.matcher && <code style={inlineCode}>{e.matcher}</code>}
              <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>
                {commandPreview(extractCommand(e.rawCommand), 1)}
              </span>
            </span>
            <ScopeBadge scope={e.scope} settingsPath={e.settingsPath} />
            <HookToggleButton
              hookId={e.hookId}
              scope={e.scope}
              projectPath={e.scope === "local" ? projectRootFromSettings(e.settingsPath) : undefined}
              disabled
              onToggled={onChanged}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function extractCommand(raw: unknown): string | undefined {
  if (raw && typeof raw === "object" && "command" in raw) {
    const c = (raw as { command?: unknown }).command;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function ScopeBadge({ scope, settingsPath }: { scope: "user" | "local"; settingsPath: string }) {
  const label = scope === "user" ? "user" : fileBasename(projectRootFromSettings(settingsPath));
  return (
    <span
      title={settingsPath}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: "var(--text-muted)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
      }}
    >
      {label}
    </span>
  );
}
