import { NextRequest, NextResponse } from "next/server";
import {
  ApplyTarget,
  ApplyTemplateRequest,
  ConflictPolicy,
} from "@/lib/types";
import { applyTemplate } from "@/lib/template/applyTemplate";

const VALID_CONFLICTS: readonly ConflictPolicy[] = ["skip", "overwrite", "merge", "rename"];

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("INVALID_JSON", "Body is not valid JSON.", 400);
  }
  const validation = validateApplyTemplate(body, slug);
  if ("error" in validation) {
    return jsonError(validation.error.code, validation.error.message, 400);
  }
  const result = await applyTemplate(validation.value);
  return NextResponse.json(result);
}

function validateApplyTemplate(body: unknown, slugFromParam: string):
  | { value: ApplyTemplateRequest }
  | { error: { code: string; message: string } } {
  if (!body || typeof body !== "object") return err("INVALID_BODY", "Body must be an object.");
  const b = body as Record<string, unknown>;

  // Target.
  const t = b.target as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return err("INVALID_TARGET", "target must be an object.");
  let target: ApplyTarget;
  if (t.kind === "existing") {
    if (typeof t.slug !== "string" || t.slug.length === 0) {
      return err("INVALID_TARGET_SLUG", "target.slug must be a non-empty string.");
    }
    target = { kind: "existing", slug: t.slug };
  } else if (t.kind === "new") {
    if (typeof t.name !== "string" || t.name.length === 0) {
      return err("INVALID_TARGET_NAME", "target.name must be a non-empty string.");
    }
    if (typeof t.relPath !== "string" || t.relPath.length === 0) {
      return err("INVALID_TARGET_REL_PATH", "target.relPath must be a non-empty string.");
    }
    target = {
      kind: "new",
      name: t.name,
      relPath: t.relPath,
      gitInit: t.gitInit !== false,
    };
  } else {
    return err("INVALID_TARGET_KIND", `target.kind must be "existing" or "new"; got "${String(t.kind)}".`);
  }

  // Conflict default.
  const conflictDefault = b.conflictDefault as unknown;
  if (typeof conflictDefault !== "string" || !(VALID_CONFLICTS as readonly string[]).includes(conflictDefault)) {
    return err("INVALID_CONFLICT_DEFAULT", `conflictDefault must be one of ${VALID_CONFLICTS.join(", ")}.`);
  }

  // Per-unit conflict overrides (optional).
  let perUnitConflict: Record<string, ConflictPolicy> | undefined;
  if (b.perUnitConflict !== undefined) {
    if (typeof b.perUnitConflict !== "object" || b.perUnitConflict === null) {
      return err("INVALID_PER_UNIT_CONFLICT", "perUnitConflict must be an object when present.");
    }
    const out: Record<string, ConflictPolicy> = {};
    for (const [k, v] of Object.entries(b.perUnitConflict as Record<string, unknown>)) {
      if (typeof v !== "string" || !(VALID_CONFLICTS as readonly string[]).includes(v)) {
        return err("INVALID_PER_UNIT_CONFLICT", `perUnitConflict["${k}"] must be one of ${VALID_CONFLICTS.join(", ")}.`);
      }
      out[k] = v as ConflictPolicy;
    }
    perUnitConflict = out;
  }

  return {
    value: {
      templateSlug: slugFromParam,
      target,
      conflictDefault: conflictDefault as ConflictPolicy,
      perUnitConflict,
      dryRun: b.dryRun === true,
    },
  };
}

function err(code: string, message: string) {
  return { error: { code, message } };
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json(
    {
      ok: false,
      results: [],
      summary: { applied: 0, merged: 0, skipped: 0, errors: 0, wouldApply: 0 },
      error: { code, message },
    },
    { status }
  );
}
