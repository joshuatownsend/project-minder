import { NextResponse } from "next/server";
import { processManager } from "@/lib/processManager";

export async function GET() {
  return NextResponse.json(processManager.getAll());
}
