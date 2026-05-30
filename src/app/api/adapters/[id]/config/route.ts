import { NextRequest, NextResponse } from "next/server";
import { getAdapter, getEnabledAdapters } from "@/lib/adapters";
import { readConfig as readMinderConfig } from "@/lib/config";

// Read-only config surface for a harness (item 1). Returns 404 — never 500 —
// for the three "no surface" cases: unknown harness id, a harness without a
// readConfig implementation, and a harness that isn't enabled (enabledAdapters).
// `getAdapter` returns undefined for junk ids, so there's no path-traversal
// surface. The adapter's readConfig is itself degrade-silent; the try/catch is
// a backstop so a read-only view can never surface a 500.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const adapter = getAdapter(id);
  if (!adapter || typeof adapter.readConfig !== "function") {
    return NextResponse.json(
      { error: "No read-only config surface for this harness." },
      { status: 404 }
    );
  }

  const config = await readMinderConfig();
  if (!getEnabledAdapters(config).some((a) => a.id === id)) {
    return NextResponse.json(
      { error: "Harness is not enabled — enable it under Settings → Adapters." },
      { status: 404 }
    );
  }

  try {
    const harnessConfig = await adapter.readConfig();
    return NextResponse.json(harnessConfig);
  } catch {
    // readConfig is contracted not to throw; if it does, degrade rather than 500.
    return NextResponse.json(
      {
        harnessId: id,
        displayName: adapter.displayName,
        home: "",
        present: false,
        config: null,
        rules: [],
        resources: [],
      },
      { status: 200 }
    );
  }
}
