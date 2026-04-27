import { NextResponse } from "next/server";
import { skillUpdateCache } from "@/lib/skillUpdateCache";

export async function POST() {
  skillUpdateCache.refresh();
  return NextResponse.json({ ok: true });
}
