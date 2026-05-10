import type { Provenance } from "@/lib/indexer/types";

export function formatFrontmatterValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => formatFrontmatterValue(v)).join(", ");
  // JSON.stringify returns undefined for functions/symbols and throws on
  // circular refs / BigInt. YAML frontmatter shouldn't yield those, but the
  // helper is exported and the type signature promises a string.
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Filter a frontmatter Record to the rows the Overview table should
 * surface. Drops `name` + `description` (already shown in the header)
 * and any null / undefined / empty-string values.
 */
export function frontmatterTableEntries(
  fm: Record<string, unknown>,
): Array<[string, unknown]> {
  return Object.entries(fm).filter(([k, v]) => {
    if (k === "name" || k === "description") return false;
    if (v === null || v === undefined) return false;
    if (typeof v === "string" && v.length === 0) return false;
    return true;
  });
}

/**
 * Build the ordered row list for the Versions tab. Only marketplace-plugin
 * provenance carries version metadata; other kinds (`user-local`,
 * `project-local`, `lockfile`) are not version-tracked, so callers
 * should render the "Not version-tracked" placeholder when this returns
 * an empty array.
 */
export function versionRows(
  provenance: Provenance,
): Array<{ label: string; value: string }> {
  if (provenance.kind !== "marketplace-plugin") return [];

  const candidates: Array<{ label: string; value?: string }> = [
    { label: "Plugin", value: provenance.pluginName },
    { label: "Version", value: provenance.pluginVersion },
    { label: "Marketplace", value: provenance.marketplace },
    { label: "Repo", value: provenance.marketplaceRepo },
    { label: "Commit", value: provenance.gitCommitSha },
    { label: "Installed", value: provenance.installedAt },
    { label: "Last updated", value: provenance.lastUpdated },
  ];

  return candidates.flatMap((c) =>
    typeof c.value === "string" && c.value.length > 0
      ? [{ label: c.label, value: c.value }]
      : [],
  );
}
