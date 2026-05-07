import { NextResponse } from "next/server";
import { sendPushAll } from "@/lib/push/sender";

export async function POST() {
  const ts = Date.now();
  const summary = await sendPushAll(
    {
      title: "Project Minder",
      body: `Test notification (ts=${ts})`,
      url: "/",
      tag: `test-${ts}`,
    },
    `push.test:ts=${ts}`
  );
  return NextResponse.json({ ok: true, ...summary });
}
