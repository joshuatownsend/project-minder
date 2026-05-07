import { NextRequest, NextResponse } from "next/server";
import { sendTelegram, sendTelegramDirect } from "@/lib/notifications/telegram";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const ts = Date.now();

  // Optional override: caller supplies creds for testing without saving.
  if (typeof body?.botToken === "string" && typeof body?.chatId === "string") {
    const result = await sendTelegramDirect(
      body.botToken,
      body.chatId,
      `Project Minder test (ts=${ts})`
    );
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  }

  // Default path: use configured creds. Append ts to bypass dedup window.
  const result = await sendTelegram(`Project Minder test (ts=${ts})`, `telegram.test:ts=${ts}`);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
