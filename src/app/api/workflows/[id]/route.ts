import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { jsonWithCacheControl } from "@/lib/httpCache";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { walkClaudeWorkflows } from "@/lib/indexer/walkWorkflows";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const config = await readConfig();
  if (!getFlag(config.featureFlags, "workflowCatalog")) {
    return NextResponse.json(null, { status: 404 });
  }

  const entries = await walkClaudeWorkflows();
  // The id is `workflow:<name>`; accept the bare name too, since that is what a
  // human reads off the page and is likely to type.
  const entry = entries.find((e) => e.id === id || e.name === id);
  if (!entry) return NextResponse.json(null, { status: 404 });
  return jsonWithCacheControl(entry);
}
