import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { invalidateCache, setCachedScan } from "@/lib/cache";

export async function POST() {
  invalidateCache();
  const result = await scanAllProjects();
  setCachedScan(result);
  return NextResponse.json(result);
}
