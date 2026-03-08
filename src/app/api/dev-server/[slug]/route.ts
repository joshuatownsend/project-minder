import { NextRequest, NextResponse } from "next/server";
import { processManager } from "@/lib/processManager";

export const runtime = "nodejs";

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
      port?: number;
    };

    switch (action) {
      case "start": {
        if (!projectPath) {
          return NextResponse.json(
            { error: "projectPath required" },
            { status: 400 }
          );
        }
        const info = await processManager.start(slug, projectPath, port);
        return NextResponse.json(info);
      }
      case "stop": {
        const info = processManager.stop(slug);
        return NextResponse.json(info || { status: "stopped", slug });
      }
      case "restart": {
        if (!projectPath) {
          return NextResponse.json(
            { error: "projectPath required" },
            { status: 400 }
          );
        }
        const info = await processManager.restart(slug, projectPath, port);
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
