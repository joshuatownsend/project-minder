import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { processManager } from "@/lib/processManager";
import { readConfig, getDevRoots } from "@/lib/config";

export const runtime = "nodejs";

// S2 — `port` arrives as untyped JSON, not the `number` the body type
// claims. It flows into processManager.start/restart -> String(portOverride)
// -> spawn args (processManager.ts, platform.ts), so anything that isn't a
// plausible TCP port must be rejected here, before it ever reaches process
// spawning. Runtime-check against `unknown`, not the (unenforced) TS type.
function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Verify projectPath is a subdirectory of one of the configured devRoots. */
async function validateProjectPath(projectPath: string): Promise<string | null> {
  const config = await readConfig();
  const normalized = path.resolve(projectPath);
  const roots = getDevRoots(config).map((r) => path.resolve(r));
  const allowed = roots.some(
    (root) => normalized.startsWith(root + path.sep) || normalized === root
  );
  if (!allowed) {
    return `projectPath must be within one of the configured scan roots`;
  }
  return null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const info = processManager.get(slug);

  if (!info) {
    return NextResponse.json({ status: "stopped", slug });
  }

  return NextResponse.json(info);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  try {
    const body = await request.json();
    const { action, projectPath, port } = body as {
      action: "start" | "stop" | "restart";
      projectPath: string;
      port?: unknown;
    };

    // S2 — validate `port` before it can reach either "start" or "restart".
    // Absent/null means "no override, let processManager detect one" and is
    // fine; anything present that isn't an integer 1-65535 is rejected.
    if (port !== undefined && port !== null && !isValidPort(port)) {
      return NextResponse.json(
        { error: "port must be an integer 1-65535" },
        { status: 400 }
      );
    }
    const validatedPort = isValidPort(port) ? port : undefined;

    switch (action) {
      case "start": {
        if (!projectPath) {
          return NextResponse.json(
            { error: "projectPath required" },
            { status: 400 }
          );
        }
        const pathErr = await validateProjectPath(projectPath);
        if (pathErr) {
          return NextResponse.json({ error: pathErr }, { status: 403 });
        }
        const info = await processManager.start(slug, projectPath, validatedPort);
        return NextResponse.json(info);
      }
      case "stop": {
        const info = await processManager.stop(slug);
        return NextResponse.json(info || { status: "stopped", slug });
      }
      case "restart": {
        if (!projectPath) {
          return NextResponse.json(
            { error: "projectPath required" },
            { status: 400 }
          );
        }
        const pathErr2 = await validateProjectPath(projectPath);
        if (pathErr2) {
          return NextResponse.json({ error: pathErr2 }, { status: 403 });
        }
        const info = await processManager.restart(slug, projectPath, validatedPort);
        return NextResponse.json(info);
      }
      default:
        return NextResponse.json(
          { error: "Invalid action. Use start, stop, or restart." },
          { status: 400 }
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
