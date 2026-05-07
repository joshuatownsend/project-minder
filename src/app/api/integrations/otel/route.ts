import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  getOtelInstallStatus,
  installOtelEnv,
  removeOtelEnv,
} from "@/lib/otelSettings";

const DEFAULT_ENDPOINT = "http://localhost:4100/api/otel";

export async function GET(): Promise<NextResponse> {
  try {
    const status = await getOtelInstallStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const { action, endpoint } = body as Record<string, unknown>;

  if (action === "install") {
    const ep =
      typeof endpoint === "string" && endpoint.trim().length > 0
        ? endpoint.trim()
        : DEFAULT_ENDPOINT;
    try {
      new URL(ep);
    } catch {
      return NextResponse.json({ error: "endpoint must be a valid URL" }, { status: 400 });
    }
    try {
      await installOtelEnv(ep);
      return NextResponse.json(await getOtelInstallStatus());
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  if (action === "remove") {
    try {
      await removeOtelEnv();
      return NextResponse.json(await getOtelInstallStatus());
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json(
    { error: 'action must be "install" or "remove"' },
    { status: 400 },
  );
}
