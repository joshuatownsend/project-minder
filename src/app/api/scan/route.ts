import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { invalidateCache, setCachedScan } from "@/lib/cache";
import { invalidateCatalogCache } from "@/lib/indexer/catalog";

export async function POST() {
  invalidateCache();
  invalidateCatalogCache();
  const result = await scanAllProjects();
  setCachedScan(result);
  return NextResponse.json(result);
}
