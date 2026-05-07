import { NextRequest, NextResponse } from "next/server";
import { setSecret, deleteSecret, getSecret, listSecretMetadata } from "@/lib/llm/secretsStore";

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
  await deleteSecret("telegram.bot_token");
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const [meta, value] = await Promise.all([listSecretMetadata(), getSecret("telegram.bot_token")]);
  return NextResponse.json({
    configured: meta.keys.includes("telegram.bot_token") && !!value,
    mtime: meta.mtime,
  });
}
