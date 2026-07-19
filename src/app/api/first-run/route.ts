import { NextResponse } from "next/server";
import { isFirstRun } from "@/lib/config";
import { getDevRootCandidates } from "@/lib/platform";

/**
 * Whether the dashboard should show first-run setup instead of an empty grid.
 *
 * Deliberately its own route rather than a field on `GET /api/config`: that
 * route returns the bare `MinderConfig` and clients round-trip it back through
 * `PUT`, so a derived, non-persistable field there would be written into
 * `.minder.json` by the next save.
 *
 * `candidates` is returned so the setup UI can show the paths we looked for —
 * "we checked C:\dev and C:\Users\you\dev" is a far better prompt than an
 * empty text box, and it's the same list the probe used, not a second guess.
 */
export async function GET() {
  return NextResponse.json({
    firstRun: await isFirstRun(),
    candidates: getDevRootCandidates(),
  });
}
