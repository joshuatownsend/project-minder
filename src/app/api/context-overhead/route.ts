import "server-only";
import { NextResponse } from "next/server";
import { gatherContextOverhead } from "@/lib/contextOverheadComposed";

/**
 * `/api/context-overhead` — portfolio-wide context-overhead estimate
 * (TODO #135 / Phase 3). Mounted by `ContextOverheadPanel` on `/stats`.
 *
 * Composition of inputs (user config, catalog, user CLAUDE.md, observed
 * session samples) lives in `@/lib/contextOverheadComposed` so the MCP
 * `get-context-overhead` tool can reuse it without re-implementing the
 * SQL probe and input gather.
 */
export async function GET() {
  const breakdown = await gatherContextOverhead();
  return NextResponse.json(breakdown, {
    headers: { "Cache-Control": "no-store" },
  });
}
