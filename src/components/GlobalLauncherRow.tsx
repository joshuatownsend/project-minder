"use client";

/**
 * GlobalLauncherRow — the thin workflow-launcher strip under the top bar.
 *
 * Renders `LauncherChips` in global (project-picker) mode on every page, except
 * the project detail route (`/project/[slug]`), which already carries its own
 * per-project strip — showing both there would be redundant. Gated by the
 * `workflowLauncher` feature flag.
 */

import { usePathname } from "next/navigation";
import { useWorkflowLauncherEnabled } from "./ConfigProvider";
import { LauncherChips } from "./LauncherChips";

export function GlobalLauncherRow() {
  const enabled = useWorkflowLauncherEnabled();
  const pathname = usePathname();

  if (!enabled) return null;
  // The project detail page renders its own (project-scoped) strip.
  if (pathname?.startsWith("/project/")) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "6px 20px",
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-base)",
        overflowX: "auto",
      }}
    >
      <LauncherChips label="Quick Launch" />
    </div>
  );
}
