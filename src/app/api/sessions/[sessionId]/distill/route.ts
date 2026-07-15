import { NextRequest, NextResponse } from "next/server";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { getDb } from "@/lib/db/connection";
import { getSessionDetail } from "@/lib/data";
import { distillSession } from "@/lib/llm/distill";
import { LLMError } from "@/lib/llm/autoTitle";
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

  const [{ detail }, config] = await Promise.all([getSessionDetail(sessionId), readConfig()]);
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (detail.distilledText && !regenerate) {
    return NextResponse.json({ text: detail.distilledText, distilledAt: detail.distilledAt, cached: true });
  }
  const turns = (detail.timeline ?? [])
    .filter((e) => e.type === "user" || e.type === "assistant")
    .map((e) => ({ role: e.type as "user" | "assistant", content: e.content }));

  try {
    const { text } = await distillSession({
      endpoint: config.autoTitle?.endpoint,
      model: config.autoTitle?.model,
      turns,
    });

    const distilledAt = new Date().toISOString();
    const db = await getDb();
    if (db) {
      db.prepare(
        "UPDATE sessions SET distilled_text = ?, distilled_at = ? WHERE session_id = ?"
      ).run(text, distilledAt, sessionId);
    }

    return NextResponse.json({ text, distilledAt, cached: false });
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
  return NextResponse.json({
    text: detail.distilledText ?? null,
    distilledAt: detail.distilledAt ?? null,
  });
}
