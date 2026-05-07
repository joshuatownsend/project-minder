import { NextRequest, NextResponse } from "next/server";
import { setSecret, listSecretMetadata } from "@/lib/llm/secretsStore";

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (typeof body?.apiKey !== "string" || body.apiKey.length === 0) {
    return NextResponse.json({ error: "apiKey must be a non-empty string" }, { status: 400 });
  }
  if (body.apiKey.length > 512) {
    return NextResponse.json({ error: "apiKey too long" }, { status: 400 });
  }
  await setSecret("llm.api_key", body.apiKey);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await setSecret("llm.api_key", "");
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const meta = await listSecretMetadata();
  return NextResponse.json({
    configured: meta.keys.includes("llm.api_key"),
    mtime: meta.mtime,
  });
}
