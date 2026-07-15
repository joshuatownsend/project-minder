import { NextRequest, NextResponse } from "next/server";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { getSessionDetail } from "@/lib/data";
import { launchTerminal } from "@/lib/terminal/launch";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
  const { sessionId } = await params;
  const { detail } = await getSessionDetail(sessionId);

  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const command = `claude --resume ${sessionId}`;
  const result = await launchTerminal({ cwd: detail.projectPath, command });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
