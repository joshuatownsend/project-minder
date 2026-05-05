import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { FileCache } from "@/lib/usage/cache";

export interface FacetData {
  session_id?: string;
  underlying_goal?: string;
  goal_categories?: Record<string, number>;
  outcome?: string;
  user_satisfaction_counts?: Record<string, number>;
  claude_helpfulness?: string;
  session_type?: string;
  friction_counts?: Record<string, number>;
  friction_detail?: string;
  primary_success?: string;
  brief_summary?: string;
}

export interface FacetsAggregate {
  sessionCount: number;
  outcomeCounts: Record<string, number>;
  helpfulnessCounts: Record<string, number>;
  satisfactionCounts: Record<string, number>;
  frictionCounts: Record<string, number>;
  sessionTypeCounts: Record<string, number>;
}

const FACETS_DIR = path.join(os.homedir(), ".claude", "usage-data", "facets");
const BATCH_SIZE = 20;

const globalForFacets = globalThis as unknown as {
  __facetsCache?: FileCache<FacetData>;
};

function getCache(): FileCache<FacetData> {
  if (!globalForFacets.__facetsCache) {
    globalForFacets.__facetsCache = new FileCache<FacetData>({ maxEntries: 2000 });
  }
  return globalForFacets.__facetsCache;
}

/**
 * Read the facets JSON for a single session. Returns null when the file
 * is absent ("no feedback recorded" — loud, not silent). Throws on
 * malformed JSON.
 */
export async function getSessionFacets(sessionId: string): Promise<FacetData | null> {
  const filePath = path.join(FACETS_DIR, `${sessionId}.json`);
  const result = await getCache().getOrCompute(filePath, async (fp) => {
    const raw = await fs.readFile(fp, "utf8");
    return JSON.parse(raw) as FacetData;
  });
  return result ?? null;
}

/**
 * Aggregate facets across a set of session IDs. Sessions with no facets
 * file are silently skipped (they have no feedback). Parse errors on
 * individual files throw (malformed feedback is a loud failure — it
 * shouldn't silently be dropped from aggregates).
 */
export async function getFacetsAggregate(sessionIds: string[]): Promise<FacetsAggregate> {
  const agg: FacetsAggregate = {
    sessionCount: 0,
    outcomeCounts: {},
    helpfulnessCounts: {},
    satisfactionCounts: {},
    frictionCounts: {},
    sessionTypeCounts: {},
  };

  for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
    const batch = sessionIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(getSessionFacets));

    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
      if (r.value === null) continue;

      agg.sessionCount++;
      const f = r.value;

      if (f.outcome) agg.outcomeCounts[f.outcome] = (agg.outcomeCounts[f.outcome] ?? 0) + 1;
      if (f.claude_helpfulness) {
        agg.helpfulnessCounts[f.claude_helpfulness] =
          (agg.helpfulnessCounts[f.claude_helpfulness] ?? 0) + 1;
      }
      if (f.user_satisfaction_counts) {
        for (const [k, v] of Object.entries(f.user_satisfaction_counts)) {
          agg.satisfactionCounts[k] = (agg.satisfactionCounts[k] ?? 0) + v;
        }
      }
      if (f.friction_counts) {
        for (const [k, v] of Object.entries(f.friction_counts)) {
          agg.frictionCounts[k] = (agg.frictionCounts[k] ?? 0) + v;
        }
      }
      if (f.session_type) {
        agg.sessionTypeCounts[f.session_type] = (agg.sessionTypeCounts[f.session_type] ?? 0) + 1;
      }
    }
  }

  return agg;
}
