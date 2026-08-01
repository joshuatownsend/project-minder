import { NextRequest, NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { getDb } from "@/lib/db/connection";
import { EMBEDDING_MODEL, embedderFailure, embedderReady, modelCacheDir } from "@/lib/embeddings/model";
import { chunkCorpusReady, countChunks, countEmbedded } from "@/lib/embeddings/store";
import { DEFAULT_PASS_CHUNKS, runEmbeddingBackfill } from "@/lib/embeddings/backfill";

/**
 * Embedding index status and backfill.
 *
 * `GET`  — coverage, without loading the model (so the Settings page can show
 *          progress without triggering an 80 MB download).
 * `POST` — run one budgeted backfill pass and return what it did.
 *
 * The backfill is caller-driven rather than a background loop. Embedding the
 * corpus is ~40 minutes of CPU on this machine; a loop that decides on its own
 * to spend that is not something a local dashboard should do silently.
 */

export const dynamic = "force-dynamic";

/** Ceiling on a single request's work, so one POST can't run for an hour. */
const MAX_PASS_CHUNKS = 20_000;

export async function GET(): Promise<NextResponse> {
  const config = await readConfig();
  const enabled = getFlag(config.featureFlags, "semanticSearch", false);

  const db = await getDb();
  if (!db) {
    return NextResponse.json({
      enabled,
      available: false,
      reason: "SQLite index unavailable (better-sqlite3 not installed)",
      model: EMBEDDING_MODEL,
      total: 0,
      embedded: 0,
      remaining: 0,
    });
  }

  if (!chunkCorpusReady(db)) {
    return NextResponse.json({
      enabled,
      available: false,
      reason:
        "The chunked full-body search index (schema v19) has not been built yet. " +
        "Restart Minder so the migration runs, then let the session reconcile finish.",
      model: EMBEDDING_MODEL,
      total: 0,
      embedded: 0,
      remaining: 0,
    });
  }

  const total = countChunks(db);
  const embedded = countEmbedded(db, EMBEDDING_MODEL);
  return NextResponse.json({
    enabled,
    // Deliberately does NOT call loadEmbedder(): reading a progress bar must
    // not be what triggers the model download.
    available: embedderReady(),
    reason: embedderFailure(),
    model: EMBEDDING_MODEL,
    modelCacheDir: modelCacheDir(),
    total,
    embedded,
    remaining: Math.max(0, total - embedded),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const blocked = await demoWriteBlock();
  if (blocked) return blocked;

  const config = await readConfig();
  if (!getFlag(config.featureFlags, "semanticSearch", false)) {
    return NextResponse.json(
      { error: "Semantic search is disabled. Enable the `semanticSearch` feature flag in Settings first." },
      { status: 409 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as { chunks?: unknown };
  const requested = typeof body.chunks === "number" && Number.isFinite(body.chunks)
    ? Math.floor(body.chunks)
    : DEFAULT_PASS_CHUNKS;
  const chunks = Math.max(1, Math.min(requested, MAX_PASS_CHUNKS));

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "SQLite index unavailable" }, { status: 503 });
  }

  const result = await runEmbeddingBackfill(db, chunks);
  if (result.stoppedBecause === "no-chunk-corpus") {
    return NextResponse.json(
      {
        ...result,
        error:
          "The chunked full-body search index (schema v19) has not been built yet. " +
          "Restart Minder so the migration runs, then try again.",
      },
      { status: 409 }
    );
  }
  if (result.stoppedBecause === "no-model") {
    return NextResponse.json(
      { ...result, error: embedderFailure() ?? "embedding model unavailable" },
      { status: 503 }
    );
  }
  return NextResponse.json(result);
}
