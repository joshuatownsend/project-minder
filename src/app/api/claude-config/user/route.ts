import { NextResponse } from "next/server";
import { getUserConfig } from "@/lib/userConfigCache";

export async function GET() {
  const data = await getUserConfig();
  return NextResponse.json(data);
}
