import { NextRequest, NextResponse } from "next/server";
import { setSecret, listSecretMetadata } from "@/lib/llm/secretsStore";

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (typeof body?.botToken !== "string" || body.botToken.length === 0) {
    return NextResponse.json({ error: "botToken must be a non-empty string" }, { status: 400 });
  }
  if (body.botToken.length > 512) {
    return NextResponse.json({ error: "botToken too long" }, { status: 400 });
  }
  await setSecret("telegram.bot_token", body.botToken);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  // Overwrite with empty string acts as revocation — key stays in file but value is unusable.
  await setSecret("telegram.bot_token", "");
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const meta = await listSecretMetadata();
  return NextResponse.json({
    configured: meta.keys.includes("telegram.bot_token"),
    mtime: meta.mtime,
  });
}
