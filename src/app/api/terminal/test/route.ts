import { NextResponse } from "next/server";
import { launchTerminal } from "@/lib/terminal/launch";

export async function POST() {
  const result = await launchTerminal({ cwd: process.cwd() });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
