import "server-only";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { partitionClaudeHomes } from "@/lib/claudeHome";

export const dynamic = "force-dynamic";

/**
 * GET /api/claude-homes
 *
 * Which configured Claude homes can be read right now, and which cannot.
 *
 * Exists so the UI can say "one home unavailable" instead of Minder deciding
 * silently for the user (#479). A home inside a stopped WSL distro is excluded
 * from every read — deliberately, because touching it would auto-start the VM
 * (the never-wake invariant, #307/#308) — and that exclusion was invisible:
 * file-parse answers over readable homes only, while SQLite retains rows
 * indexed when that home was last up, so totals quietly disagree with
 * themselves and nothing says why.
 *
 * Cheap enough to poll: `checkWslRoot` shells `wsl.exe --list` behind its own
 * cache, and the whole answer is a handful of strings. It does NOT touch any
 * home's filesystem, which is the entire point.
 */
export async function GET(): Promise<NextResponse> {
  const config = await readConfig();
  const { readable, unavailable } = await partitionClaudeHomes(config);

  const response = NextResponse.json({
    readable,
    unavailable,
    /** True when every configured home answered. The UI's one-bit question. */
    complete: unavailable.length === 0,
  });
  // Same convention as `X-Minder-Backend`: the fact rides a header too, so a
  // client that only cares whether coverage is whole does not have to parse
  // the body.
  response.headers.set(
    "X-Minder-Homes-Unavailable",
    String(unavailable.length),
  );
  return response;
}
