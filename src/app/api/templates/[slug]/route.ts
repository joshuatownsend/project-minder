import { NextRequest, NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { readManifest } from "@/lib/template/manifest";
import { deleteTemplate, saveAsSnapshot } from "@/lib/template/promote";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const config = await readConfig();
  const result = await readManifest(config, slug);
  if (!result) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: `No template "${slug}".` } }, { status: 404 });
  }
  if ("errors" in result) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_MANIFEST",
          message: result.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
        },
      },
      { status: 422 }
    );
  }
  return NextResponse.json({ manifest: result.manifest });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const config = await readConfig();
  await deleteTemplate(config, slug);
  return NextResponse.json({ ok: true });
}

/** PATCH — currently only supports `{ action: "snapshot" }` to convert a live
 *  template into a snapshot. Future fields (rename, edit description, edit
 *  unit selection) can extend the action union. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Body is not valid JSON." } },
      { status: 400 }
    );
  }
  const b = body as Record<string, unknown> | null;
  if (!b || b.action !== "snapshot") {
    return NextResponse.json(
      { error: { code: "UNSUPPORTED_ACTION", message: 'Only { action: "snapshot" } is supported.' } },
      { status: 400 }
    );
  }

  const config = await readConfig();
  const manifestRead = await readManifest(config, slug);
  if (!manifestRead) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: `No template "${slug}".` } },
      { status: 404 }
    );
  }
  if ("errors" in manifestRead) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_MANIFEST",
          message: manifestRead.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
        },
      },
      { status: 422 }
    );
  }

  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  const result = await saveAsSnapshot(config, scan, slug, manifestRead.manifest);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ manifest: result.manifest });
}
