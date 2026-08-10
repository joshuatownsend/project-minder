import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getHookActivity, type HookActivitySource } from "@/lib/db/otelQueries";

const SOURCES: readonly HookActivitySource[] = ["auto", "otel", "transcript"];

function isSource(v: string): v is HookActivitySource {
  return (SOURCES as readonly string[]).includes(v);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const sinceParam = searchParams.get("since");
  const since      = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(since)) {
    return NextResponse.json({ error: "Invalid since parameter" }, { status: 400 });
  }

  // Rejected rather than silently coerced to `auto`. The whole point of naming
  // a source is that the two pipelines measure different things, so a typo that
  // quietly fell back would answer a question the caller did not ask and label
  // it with the source they did not pick.
  const sourceParam = searchParams.get("source");
  if (sourceParam !== null && !isSource(sourceParam)) {
    return NextResponse.json(
      { error: `Invalid source parameter — expected one of ${SOURCES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await getHookActivity({ since, source: sourceParam ?? undefined });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telemetry/hook-activity]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
