import { NextRequest, NextResponse } from "next/server";
import {
  TemplateUnitInventory,
  TemplateUnitRef,
  UnitKind,
} from "@/lib/types";
import { readConfig } from "@/lib/config";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { listTemplates } from "@/lib/template/registry";
import { createLiveTemplate } from "@/lib/template/promote";
import { emptyInventory, isValidSlug } from "@/lib/template/manifest";

const VALID_UNIT_KINDS: readonly UnitKind[] = [
  "agent",
  "skill",
  "command",
  "hook",
  "mcp",
  "plugin",
  "workflow",
  "settingsKey",
];

export async function GET() {
  const config = await readConfig();
  const { manifests, errors } = await listTemplates(config);
  return NextResponse.json({ manifests, errors });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_JSON", "Body is not valid JSON.", 400);
  }

  const validation = validateCreate(body);
  if ("error" in validation) {
    return jsonError(validation.error.code, validation.error.message, 400);
  }

  const config = await readConfig();
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  const result = await createLiveTemplate(config, scan, validation.value);
  if ("error" in result) {
    return jsonError(result.error.code, result.error.message, 400);
  }
  return NextResponse.json({ manifest: result.manifest }, { status: 201 });
}

function validateCreate(body: unknown):
  | {
      value: {
        slug: string;
        name: string;
        description?: string;
        sourceSlug: string;
        units: TemplateUnitInventory;
      };
    }
  | { error: { code: string; message: string } } {
  if (!body || typeof body !== "object") return err("INVALID_BODY", "Body must be an object.");
  const b = body as Record<string, unknown>;

  if (typeof b.slug !== "string" || !isValidSlug(b.slug)) {
    return err("INVALID_SLUG", `slug must be lowercase alphanumeric/dash, 1-64 chars.`);
  }
  if (typeof b.name !== "string" || b.name.length === 0) {
    return err("INVALID_NAME", "name must be a non-empty string.");
  }
  if (b.description !== undefined && typeof b.description !== "string") {
    return err("INVALID_DESCRIPTION", "description must be a string when present.");
  }
  if (typeof b.sourceSlug !== "string" || b.sourceSlug.length === 0) {
    return err("INVALID_SOURCE", "sourceSlug must be a non-empty string.");
  }

  const units = b.units;
  if (units !== undefined && (typeof units !== "object" || units === null || Array.isArray(units))) {
    return err("INVALID_UNITS", "units must be an object when present.");
  }

  // Tolerant intake: missing kinds become empty arrays. Refs validated below.
  const inv = (units as Record<string, unknown> | undefined) ?? {};
  const out: TemplateUnitInventory = emptyInventory();

  for (const kind of VALID_UNIT_KINDS) {
    const key =
      kind === "mcp"
        ? "mcp"
        : kind === "command"
          ? "commands"
          : kind === "plugin"
            ? "plugins"
            : kind === "workflow"
              ? "workflows"
              : kind === "settingsKey"
                ? "settings"
                : `${kind}s`;
    const list = inv[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      return err("INVALID_UNITS", `units.${key} must be an array.`);
    }
    const refs: TemplateUnitRef[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r !== "object") {
        return err("INVALID_UNIT_REF", `units.${key}[${i}] must be an object.`);
      }
      const rr = r as Record<string, unknown>;
      if (typeof rr.kind !== "string" || rr.kind !== kind) {
        return err("INVALID_UNIT_REF", `units.${key}[${i}].kind must equal "${kind}".`);
      }
      if (typeof rr.key !== "string" || rr.key.length === 0) {
        return err("INVALID_UNIT_REF", `units.${key}[${i}].key must be non-empty.`);
      }
      // Workflow keys are joined into filesystem paths during snapshot/apply.
      // Reject `..` and absolute paths up front so a crafted manifest can't
      // land on disk and later escape `.github/workflows/`.
      if (kind === "workflow") {
        if (rr.key.includes("..") || /^([\\/]|[a-zA-Z]:)/.test(rr.key)) {
          return err(
            "INVALID_UNIT_REF",
            `units.${key}[${i}].key must be a relative path inside .github/workflows/.`
          );
        }
      }
      if (rr.name !== undefined && typeof rr.name !== "string") {
        return err("INVALID_UNIT_REF", `units.${key}[${i}].name must be a string when present.`);
      }
      if (rr.description !== undefined && typeof rr.description !== "string") {
        return err("INVALID_UNIT_REF", `units.${key}[${i}].description must be a string when present.`);
      }
      refs.push({
        kind,
        key: rr.key,
        name: typeof rr.name === "string" ? rr.name : undefined,
        description: typeof rr.description === "string" ? rr.description : undefined,
      });
    }
    if (kind === "agent") out.agents = refs;
    else if (kind === "skill") out.skills = refs;
    else if (kind === "command") out.commands = refs;
    else if (kind === "hook") out.hooks = refs;
    else if (kind === "mcp") out.mcp = refs;
    else if (kind === "plugin") out.plugins = refs;
    else if (kind === "workflow") out.workflows = refs;
    else if (kind === "settingsKey") out.settings = refs;
  }

  return {
    value: {
      slug: b.slug,
      name: b.name,
      description: typeof b.description === "string" ? b.description : undefined,
      sourceSlug: b.sourceSlug,
      units: out,
    },
  };
}

function err(code: string, message: string) {
  return { error: { code, message } };
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}
