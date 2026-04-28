import { promises as fs } from "fs";
import path from "path";
import {
  MinderConfig,
  TemplateKind,
  TemplateManifest,
  TemplateUnitInventory,
  TemplateUnitRef,
  UnitKind,
} from "../types";
import { getDevRoots } from "../config";
import { atomicWriteFile, ensureDir, fileExists, withFileLock } from "./atomicFs";

/** Layout: <devRoot>/.minder/templates/<slug>/template.json
 *  For snapshots, asset files live alongside in `bundle/` mirroring a real
 *  project's `.claude/` + `.mcp.json`. */
export function templatesRootForConfig(config: MinderConfig): string {
  return path.join(getDevRoots(config)[0], ".minder", "templates");
}

export function templateDirForSlug(config: MinderConfig, slug: string): string {
  return path.join(templatesRootForConfig(config), slug);
}

export function manifestPathForSlug(config: MinderConfig, slug: string): string {
  return path.join(templateDirForSlug(config, slug), "template.json");
}

export function bundleDirForSlug(config: MinderConfig, slug: string): string {
  return path.join(templateDirForSlug(config, slug), "bundle");
}

const VALID_KINDS: readonly TemplateKind[] = ["live", "snapshot"];
const VALID_UNIT_KINDS: readonly UnitKind[] = ["agent", "skill", "command", "hook", "mcp"];

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && slug.length <= 64;
}

export function emptyInventory(): TemplateUnitInventory {
  return { agents: [], skills: [], commands: [], hooks: [], mcp: [] };
}

/** Total number of units across all kinds. Useful for UI summaries. */
export function inventoryCount(inv: TemplateUnitInventory): number {
  return inv.agents.length + inv.skills.length + inv.commands.length + inv.hooks.length + inv.mcp.length;
}

export interface ManifestValidationError {
  field: string;
  message: string;
}

/** Validates an arbitrary JSON-parsed object as a TemplateManifest. Returns
 *  either `{ manifest }` on success or `{ errors }` with one or more field-level
 *  error reports. */
export function validateManifest(
  raw: unknown
):
  | { manifest: TemplateManifest }
  | { errors: ManifestValidationError[] } {
  const errors: ManifestValidationError[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: [{ field: "(root)", message: "manifest must be an object" }] };
  }
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== 1) {
    errors.push({ field: "schemaVersion", message: "must be exactly 1" });
  }
  if (typeof r.slug !== "string" || !isValidSlug(r.slug)) {
    errors.push({ field: "slug", message: "must be lowercase alphanumeric/dash, 1-64 chars" });
  }
  if (typeof r.name !== "string" || r.name.length === 0) {
    errors.push({ field: "name", message: "must be a non-empty string" });
  }
  if (r.description !== undefined && typeof r.description !== "string") {
    errors.push({ field: "description", message: "must be a string when present" });
  }
  if (typeof r.kind !== "string" || !(VALID_KINDS as readonly string[]).includes(r.kind)) {
    errors.push({ field: "kind", message: `must be one of ${VALID_KINDS.join(", ")}` });
  }
  if (r.kind === "live") {
    if (typeof r.liveSourceSlug !== "string" || r.liveSourceSlug.length === 0) {
      errors.push({ field: "liveSourceSlug", message: "required when kind === 'live'" });
    }
  } else if (r.liveSourceSlug !== undefined && typeof r.liveSourceSlug !== "string") {
    errors.push({ field: "liveSourceSlug", message: "must be a string when present" });
  }
  if (typeof r.createdAt !== "string" || typeof r.updatedAt !== "string") {
    errors.push({ field: "createdAt/updatedAt", message: "must be ISO timestamp strings" });
  }

  // Inventory.
  const invErrors = validateInventory(r.units);
  errors.push(...invErrors);

  if (errors.length > 0) return { errors };
  return { manifest: raw as TemplateManifest };
}

function validateInventory(raw: unknown): ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [{ field: "units", message: "must be an object" }];
  }
  const u = raw as Record<string, unknown>;
  for (const kind of VALID_UNIT_KINDS) {
    const key = kind === "mcp" ? "mcp" : kind === "command" ? "commands" : `${kind}s`;
    const list = u[key];
    if (list === undefined) continue; // Allowed to be missing — treated as [].
    if (!Array.isArray(list)) {
      errors.push({ field: `units.${key}`, message: "must be an array" });
      continue;
    }
    list.forEach((entry, i) => {
      const ref = validateUnitRef(entry);
      if (ref) errors.push({ field: `units.${key}[${i}]`, message: ref });
    });
  }
  return errors;
}

function validateUnitRef(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "must be an object";
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !(VALID_UNIT_KINDS as readonly string[]).includes(r.kind)) {
    return `kind must be one of ${VALID_UNIT_KINDS.join(", ")}`;
  }
  if (typeof r.key !== "string" || r.key.length === 0) {
    return "key must be a non-empty string";
  }
  if (r.name !== undefined && typeof r.name !== "string") return "name must be a string when present";
  if (r.description !== undefined && typeof r.description !== "string") {
    return "description must be a string when present";
  }
  return null;
}

/** Reads + validates a manifest by slug. Returns undefined when the file
 *  doesn't exist or fails validation (callers can detect by counting). */
export async function readManifest(
  config: MinderConfig,
  slug: string
): Promise<{ manifest: TemplateManifest } | { errors: ManifestValidationError[] } | undefined> {
  const file = manifestPathForSlug(config, slug);
  if (!(await fileExists(file))) return undefined;
  const raw = await fs.readFile(file, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { errors: [{ field: "(file)", message: `not valid JSON: ${(e as Error).message}` }] };
  }
  // Default `units` to an empty inventory when missing. Cleaner UX than rejecting an
  // otherwise-valid manifest that just omits the field.
  if (parsed && typeof parsed === "object" && !(parsed as Record<string, unknown>).units) {
    (parsed as Record<string, unknown>).units = emptyInventory();
  }
  return validateManifest(parsed);
}

export async function writeManifest(
  config: MinderConfig,
  manifest: TemplateManifest
): Promise<void> {
  const v = validateManifest(manifest);
  if ("errors" in v) {
    throw new Error(
      `Refusing to write invalid manifest: ${v.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`
    );
  }
  const dir = templateDirForSlug(config, manifest.slug);
  const file = manifestPathForSlug(config, manifest.slug);
  return withFileLock(file, async () => {
    await ensureDir(dir);
    await atomicWriteFile(file, JSON.stringify(manifest, null, 2) + "\n");
  });
}

/** Build a fresh manifest. Caller still has to write it. */
export function buildManifest(args: {
  slug: string;
  name: string;
  description?: string;
  kind: TemplateKind;
  liveSourceSlug?: string;
  units?: TemplateUnitInventory;
}): TemplateManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    slug: args.slug,
    name: args.name,
    description: args.description,
    kind: args.kind,
    liveSourceSlug: args.kind === "live" ? args.liveSourceSlug : undefined,
    createdAt: now,
    updatedAt: now,
    units: args.units ?? emptyInventory(),
  };
}

/** Stamp `updatedAt` and write. Pure write-time helper. */
export async function touchManifest(
  config: MinderConfig,
  manifest: TemplateManifest
): Promise<TemplateManifest> {
  const updated = { ...manifest, updatedAt: new Date().toISOString() };
  await writeManifest(config, updated);
  return updated;
}

export type { TemplateUnitRef };
