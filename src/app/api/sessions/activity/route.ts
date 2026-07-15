import { NextResponse } from "next/server";
import { encodePath } from "@/lib/scanner/claudeConversations";
import { readConfig, getDevRoots } from "@/lib/config";
import { getSessionsCacheSlot } from "@/lib/server/queries/sessions";
import { demoMode } from "@/lib/demo/demoMode";

// Returns Record<projectSlug, number[]> — 14 daily session counts, UTC, oldest→newest
export async function GET() {
  // Share the demo-salted cache slot with /api/sessions (one refresh serves
  // both, and toggling the demoMode flag invalidates it — see getSessionsCacheSlot).
  const cache = await getSessionsCacheSlot();
  const isDemo = await demoMode();

  const config = await readConfig();
  const roots = getDevRoots(config);
  // Re-encoding devRoots gives Claude directory prefixes. decodeDirName is lossy
  // for hyphenated project names, so we re-encode session.projectPath to recover
  // the original Claude directory name, then strip the devRoot prefix.
  // Normalize trailing slashes before encoding; sort longest-first so a more-specific
  // root (e.g. /dev/projects) can't be shadowed by a shorter one (/dev)
  const encodedPrefixes = roots
    .map((r) => encodePath(r.replace(/[\\/]+$/, "")) + "-")
    .sort((a, b) => b.length - a.length);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (13 - i));
    return d.getTime();
  });

  const result: Record<string, number[]> = {};

  for (const session of cache.result.sessions) {
    let slug: string;
    if (isDemo) {
      // Demo session paths (C:\dev\<slug>) may not sit under the configured
      // devRoot (a customized root, or ~/dev off-Windows), so the prefix filter
      // would drop them and leave the sparklines empty. All fixtures are
      // in-scope by definition — derive the slug from the path basename.
      const base = session.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
      slug = base.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (!slug) continue;
    } else {
      const reEncoded = encodePath(session.projectPath);
      const prefix = encodedPrefixes.find((p) => reEncoded.startsWith(p));
      if (!prefix) continue;
      slug = reEncoded.slice(prefix.length).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }

    if (!result[slug]) result[slug] = new Array(14).fill(0);

    const ts = session.startTime ? new Date(session.startTime).getTime() : null;
    if (!ts) continue;

    const dayStart = new Date(ts);
    dayStart.setUTCHours(0, 0, 0, 0);
    const idx = days.findIndex((d) => d === dayStart.getTime());
    if (idx !== -1) result[slug][idx]++;
  }

  const response = NextResponse.json(result);
  response.headers.set("X-Minder-Backend", cache.result.meta.backend);
  return response;
}
