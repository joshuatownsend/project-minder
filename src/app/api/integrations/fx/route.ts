import { NextResponse } from "next/server";
import { loadFxRates, getRatesSync, getFetchedAt } from "@/lib/fxRates";

export async function GET() {
  await loadFxRates();
  return NextResponse.json({
    base: "USD",
    rates: getRatesSync(),
    fetchedAt: getFetchedAt(),
  });
}
