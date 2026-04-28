import { NextRequest, NextResponse } from "next/server";
import { applyUnit } from "@/lib/template/apply";
import {
  ApplyRequest,
  ConflictPolicy,
  UnitKind,
} from "@/lib/types";

const VALID_KINDS: readonly UnitKind[] = ["agent", "skill", "command", "hook", "mcp"];
const VALID_CONFLICTS: readonly ConflictPolicy[] = ["skip", "overwrite", "merge", "rename"];

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_JSON", "Request body is not valid JSON.", 400);
  }

  const validation = validateRequest(body);
  if ("error" in validation) {
    return jsonError(validation.error.code, validation.error.message, 400);
  }

  const result = await applyUnit(validation.value);
  // Always 200 with the structured ApplyResult body — clients inspect `ok`
  // and `error` directly. This keeps client code simple (one parsing path)
  // and avoids HTTP status-code semantics that don't quite fit
  // "validation passed but the unit was already there."
  return NextResponse.json(result);
}

function validateRequest(body: unknown):
  | { value: ApplyRequest }
  | { error: { code: string; message: string } } {
  if (!body || typeof body !== "object") {
    return err("INVALID_BODY", "Body must be an object.");
  }
  const b = body as Record<string, unknown>;

  // unit
  const unit = b.unit;
  if (!unit || typeof unit !== "object") return err("INVALID_UNIT", "unit must be an object.");
  const u = unit as Record<string, unknown>;
  if (typeof u.kind !== "string" || !(VALID_KINDS as readonly string[]).includes(u.kind)) {
    return err("INVALID_UNIT_KIND", `unit.kind must be one of ${VALID_KINDS.join(", ")}.`);
  }
  if (typeof u.key !== "string" || u.key.length === 0) {
    return err("INVALID_UNIT_KEY", "unit.key must be a non-empty string.");
  }

  // source
  const source = b.source;
  if (!source || typeof source !== "object") return err("INVALID_SOURCE", "source must be an object.");
  const s = source as Record<string, unknown>;
  if (s.kind === "project") {
    if (typeof s.slug !== "string" || s.slug.length === 0) {
      return err("INVALID_SOURCE_SLUG", "source.slug must be a non-empty string.");
    }
  } else if (s.kind !== "user") {
    return err("INVALID_SOURCE_KIND", 'source.kind must be "project" or "user".');
  }

  // target
  const target = b.target;
  if (!target || typeof target !== "object") return err("INVALID_TARGET", "target must be an object.");
  const t = target as Record<string, unknown>;
  if (t.kind !== "existing") {
    return err("INVALID_TARGET_KIND", 'target.kind must be "existing" (V1).');
  }
  if (typeof t.slug !== "string" || t.slug.length === 0) {
    return err("INVALID_TARGET_SLUG", "target.slug must be a non-empty string.");
  }

  // conflict
  if (typeof b.conflict !== "string" || !(VALID_CONFLICTS as readonly string[]).includes(b.conflict)) {
    return err("INVALID_CONFLICT", `conflict must be one of ${VALID_CONFLICTS.join(", ")}.`);
  }

  const dryRun = b.dryRun === true;

  return {
    value: {
      unit: { kind: u.kind as UnitKind, key: u.key },
      source:
        s.kind === "project"
          ? { kind: "project", slug: s.slug as string }
          : { kind: "user" },
      target: { kind: "existing", slug: t.slug as string },
      conflict: b.conflict as ConflictPolicy,
      dryRun,
    },
  };
}

function err(code: string, message: string) {
  return { error: { code, message } };
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json(
    { ok: false, status: "error", changedFiles: [], error: { code, message } },
    { status }
  );
}
