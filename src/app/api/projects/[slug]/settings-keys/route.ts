import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { tryParseJsonc } from "@/lib/scanner/util/jsonc";
import { RESERVED_SETTINGS_KEYS } from "@/lib/template/jsonPath";

interface SettingsKeyEntry {
  /** Dotted path under settings.json. */
  path: string;
  /** "scalar" | "array" | "object" — useful so the UI can pick a sensible label. */
  valueType: "scalar" | "array" | "object";
  /** Truncated JSON preview of the value at this path. Strings inside `env`
   *  are redacted (replaced with empty strings) before previewing — env
   *  values are the only common settings.json secret. */
  preview: string;
}

/** Returns the dotted-path inventory of `<project>/.claude/settings.json`,
 *  excluding the keys covered by dedicated unit kinds (hooks, mcpServers,
 *  enabledPlugins). Used by the MarkAsTemplateModal settings picker. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: `No project "${slug}".` } },
      { status: 404 }
    );
  }

  const settingsPath = path.join(project.path, ".claude", "settings.json");
  let doc: unknown;
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    doc = tryParseJsonc<unknown>(raw);
  } catch {
    // Missing file or unreadable → treat as empty inventory.
    return NextResponse.json({ entries: [] });
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return NextResponse.json({ entries: [] });
  }

  const root = doc as Record<string, unknown>;
  const entries: SettingsKeyEntry[] = [];

  for (const [key, value] of Object.entries(root)) {
    if (RESERVED_SETTINGS_KEYS.has(key)) continue;
    // The apply layer's `parsePath` interprets dots as path separators, so a
    // literal key like "feature.flag" can't be addressed safely by Template
    // Mode — picking it would produce a UNIT_NOT_FOUND at apply time.
    // Filter unsupported keys out of the picker entirely; users can still
    // template the parent object if needed.
    if (key.includes(".")) continue;
    entries.push(buildEntry(key, value, key === "env"));
    // Surface common known nested paths so the user can pick the granular
    // path rather than the whole parent object.
    if (key === "permissions" && value && typeof value === "object" && !Array.isArray(value)) {
      const perms = value as Record<string, unknown>;
      for (const sub of ["allow", "ask", "deny"]) {
        if (sub in perms) {
          entries.push(buildEntry(`permissions.${sub}`, perms[sub], false));
        }
      }
    }
  }

  // Stable order: alphabetic on path.
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return NextResponse.json({ entries });
}

function buildEntry(keyPath: string, value: unknown, redactStrings: boolean): SettingsKeyEntry {
  let valueType: SettingsKeyEntry["valueType"];
  if (Array.isArray(value)) valueType = "array";
  else if (value !== null && typeof value === "object") valueType = "object";
  else valueType = "scalar";

  const sanitized = redactStrings ? redactStringValues(value) : value;
  const json = JSON.stringify(sanitized);
  const preview = json && json.length > 120 ? json.slice(0, 117) + "…" : json ?? "";

  return { path: keyPath, valueType, preview };
}

/** Replaces every string value inside `v` (recursively) with the empty
 *  string. Used for `env` previews so the env *keys* are visible but values
 *  never leak through the API. */
function redactStringValues(v: unknown): unknown {
  if (typeof v === "string") return "";
  if (Array.isArray(v)) return v.map(redactStringValues);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v)) out[k] = redactStringValues(vv);
    return out;
  }
  return v;
}
