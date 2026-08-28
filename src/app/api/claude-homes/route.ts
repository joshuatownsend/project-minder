import "server-only";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { partitionClaudeHomes } from "@/lib/claudeHome";
import { demoMode } from "@/lib/demo/demoMode";

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
  // Demo mode never reads the real homes (Codex P1, PR #510). Both arrays
  // carry ABSOLUTE host paths — the machine username, where the user keeps
  // their Claude homes, and the names of their WSL distros — and the banner
  // renders an unavailable one verbatim. Every other path-bearing route
  // substitutes synthetic data here; this one has nothing to substitute, so it
  // reports full coverage of nothing, which is the honest demo answer: a demo
  // machine has no unreadable homes to warn about.
  //
  // Before `readConfig`, not after: the point is not to filter the paths out of
  // the response but never to look at them, and never to spend a `wsl.exe` or
  // UNC probe on a viewer's behalf.
  if (await demoMode()) {
    return NextResponse.json({ readable: [], unavailable: [], complete: true });
  }

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
