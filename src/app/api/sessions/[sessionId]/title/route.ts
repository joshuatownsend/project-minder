import { NextRequest, NextResponse } from "next/server";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { getDb } from "@/lib/db/connection";
import { getSessionDetail } from "@/lib/data";
import { generateTitle, LLMError } from "@/lib/llm/autoTitle";
import { readConfig } from "@/lib/config";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
  const { sessionId } = await params;
  const body = await request.json().catch(() => ({}));
  const regenerate = body?.regenerate === true;

  const { detail } = await getSessionDetail(sessionId);
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (detail.generatedTitle && !regenerate) {
    return NextResponse.json({ title: detail.generatedTitle, cached: true });
  }

  const config = await readConfig();
  const turns = (detail.timeline ?? [])
    .filter((e) => e.type === "user")
    .map((e) => ({ role: "user" as const, content: e.content }));

  try {
    const { title } = await generateTitle({
      endpoint: config.autoTitle?.endpoint,
      model: config.autoTitle?.model,
      turns,
    });

    const db = await getDb();
    if (db) {
      db.prepare("UPDATE sessions SET generated_title = ? WHERE session_id = ?").run(title, detail.sessionId);
    }

    return NextResponse.json({ title, cached: false });
  } catch (err) {
    if (err instanceof LLMError) {
      return NextResponse.json({ error: err.message }, { status: err.status >= 400 ? err.status : 502 });
    }
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { detail } = await getSessionDetail(sessionId);
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json({ title: detail.generatedTitle ?? null });
}
