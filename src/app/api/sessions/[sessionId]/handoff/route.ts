import path from "path";
import os from "os";
import { NextRequest, NextResponse } from "next/server";
import {
  loadSessionTurnsBySessionId,
  getJsonlMaxMtime,
  SessionTurnsLoadError,
} from "@/lib/usage/parser";
import {
  extractHandoffFacts,
  readCompactionSummary,
  scoreCompactionFidelity,
} from "@/lib/usage/sessionHandoff";
import type { HandoffFacts, CompactionFidelity } from "@/lib/usage/sessionHandoff";
import { generateHandoffDoc } from "@/lib/usage/sessionHandoffDoc";
import type { HandoffVerbosity } from "@/lib/usage/sessionHandoffDoc";
import { getOrCreateRouteCache } from "@/lib/routeCache";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
import { indexedSessionPath } from "@/lib/data/indexedSessionPath";

const VALID_VERBOSITIES = new Set<HandoffVerbosity>([
  "minimal",
  "standard",
  "verbose",
  "full",
]);

const CACHE_TTL_MS = 5 * 60 * 1000;

interface HandoffResponse {
  sessionId: string;
  facts: HandoffFacts;
  fidelity: CompactionFidelity | null;
  doc: string;
  meta: { durationMs: number };
}

interface CacheSlot {
  data: HandoffResponse;
  jsonlMtime: number;
}

const cache = getOrCreateRouteCache<CacheSlot>("handoff", { ttlMs: CACHE_TTL_MS });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const start = Date.now();
  const { sessionId } = await params;

  const verbosityParam = request.nextUrl.searchParams.get("verbosity") ?? "standard";
  if (!VALID_VERBOSITIES.has(verbosityParam as HandoffVerbosity)) {
    return NextResponse.json(
      {
        error: `Invalid verbosity. Must be one of: ${[...VALID_VERBOSITIES].join(", ")}`,
      },
      { status: 400 }
    );
  }
  const verbosity = verbosityParam as HandoffVerbosity;

  const cacheKey = `${sessionId}:${verbosity}`;
  const cached = cache.get(cacheKey);
  const currentMtime = getJsonlMaxMtime();
  if (cached && cached.jsonlMtime === currentMtime) {
    return NextResponse.json(cached.data);
  }

  let turns;
  try {
    turns = await loadSessionTurnsBySessionId(sessionId);
  } catch (err) {
    if (err instanceof SessionTurnsLoadError) {
      // eslint-disable-next-line no-console
      console.error(`[/api/sessions/${sessionId}/handoff]`, err);
      return NextResponse.json(
        { error: `Could not parse session JSONL: ${err.message}` },
        { status: 500 }
      );
    }
    throw err;
  }
  if (!turns) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const facts = extractHandoffFacts(turns);

  // RESOLVED, not reconstructed (#486). This built
  // `~/.claude/projects/<dir>/<id>.jsonl` by hand, which is wrong twice over:
  // it assumes the FLAT layout, so a nested subagent transcript was never
  // found; and it hardcodes `os.homedir()`, so a session in any configured
  // extra Claude home was never found either. Both failures are silent — the
  // read misses and fidelity is simply reported as absent, which is
  // indistinguishable from a session that was never compacted.
  let fidelity: CompactionFidelity | null = null;
  const located = await resolveSessionJsonl(sessionId, {
    indexedPath: indexedSessionPath,
  });
  if (located) {
    const summary = await readCompactionSummary(located.filePath);
    if (summary) {
      fidelity = scoreCompactionFidelity(facts, summary);
    }
  }

  const doc = generateHandoffDoc({
    sessionId,
    projectName: turns[0]?.projectSlug ?? undefined,
    facts,
    fidelity: fidelity ?? undefined,
    turns,
    verbosity,
  });

  const now = Date.now();
  const data: HandoffResponse = {
    sessionId,
    facts,
    fidelity,
    doc,
    meta: { durationMs: now - start },
  };
  cache.set(cacheKey, { data, jsonlMtime: currentMtime });
  return NextResponse.json(data);
}
