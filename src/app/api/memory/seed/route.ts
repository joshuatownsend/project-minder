import { promises as fs } from "fs";
import path from "path";
import { NextResponse, type NextRequest } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { generateSeedCandidates } from "@/lib/memory/seedGenerator";
import { writeMemoryFile, memoryDirFor } from "@/lib/scanner/memoryWriter";
import { userMemoryPath } from "@/lib/memory/safety";
import { parseAllSessions } from "@/lib/usage/parser";
import { classifyTurn } from "@/lib/usage/classifier";
import type { SeedCandidate } from "@/lib/types";

interface PromoteRequest {
  candidates: Array<{
    fileName: string;
    targetProjectPath: string;
    body: string;
  }>;
}

export async function GET(request: NextRequest) {
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  // Read global CLAUDE.md if present; otherwise the generator just omits
  // user_role.md from the candidate set rather than failing.
  let userClaudeMd: string | null = null;
  try {
    userClaudeMd = await fs.readFile(userMemoryPath(), "utf-8");
  } catch {
    userClaudeMd = null;
  }

  // Session category mix drives user_workstyle.md. Single-flight cached, so
  // a /memory page load and a /memory/seed page load share the same pass.
  const sessions = await parseAllSessions();
  const sessionCategories = new Map<string, number>();
  for (const turns of sessions.values()) {
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      const cat = classifyTurn(turn);
      sessionCategories.set(cat, (sessionCategories.get(cat) ?? 0) + 1);
    }
  }

  const candidates = generateSeedCandidates({
    userClaudeMd,
    projects: scan.projects,
    sessionCategories,
  });

  // Detect on-disk conflicts so the UI can show 3-way diff without a second
  // round-trip. Per-project candidates resolve against their own dir;
  // user-scope candidates need an anchor project (?anchor=<projectPath>)
  // before we can locate where they'd land.
  const anchorPath = request.nextUrl.searchParams.get("anchor") ?? "";
  const allProjectPaths = scan.projects.map((p) => p.path);
  const augmented = await Promise.all(
    candidates.map((c) => attachConflict(c, anchorPath, allProjectPaths)),
  );

  return NextResponse.json({
    candidates: augmented,
    anchorOptions: scan.projects
      .filter((p) => p.status === "active")
      .map((p) => ({ slug: p.slug, name: p.name, path: p.path })),
  });
}

async function attachConflict(
  candidate: SeedCandidate,
  anchorPath: string,
  allProjectPaths: string[],
): Promise<SeedCandidate> {
  const targetPath =
    candidate.scope === "per-project"
      ? candidate.targetProjectPath
      : anchorPath || null;
  if (!targetPath) return candidate;
  // Safety: confirm anchor was a real scanned project before we trust it.
  if (candidate.scope === "user" && !allProjectPaths.includes(targetPath)) {
    return candidate;
  }
  const existingPath = path.join(memoryDirFor(targetPath), candidate.fileName);
  try {
    const existingBody = await fs.readFile(existingPath, "utf-8");
    return {
      ...candidate,
      conflict: {
        existingPath,
        existingBody,
        existingIsSeeded: existingBody.includes("seeded: true"),
      },
    };
  } catch {
    return candidate;
  }
}

export async function POST(request: NextRequest) {
  let body: PromoteRequest;
  try {
    body = (await request.json()) as PromoteRequest;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (!body.candidates || !Array.isArray(body.candidates)) {
    return NextResponse.json({ error: "MISSING_CANDIDATES" }, { status: 400 });
  }

  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const validProjectPaths = new Set(scan.projects.map((p) => p.path));

  const results = await Promise.all(
    body.candidates.map(async (c) => {
      if (!c.fileName || typeof c.fileName !== "string") {
        return { fileName: c.fileName ?? "", ok: false, error: "INVALID_NAME" as const };
      }
      if (!validProjectPaths.has(c.targetProjectPath)) {
        return { fileName: c.fileName, ok: false, error: "UNKNOWN_PROJECT" as const };
      }
      const result = await writeMemoryFile(c.targetProjectPath, c.fileName, c.body);
      return result.ok
        ? { fileName: c.fileName, ok: true as const }
        : { fileName: c.fileName, ok: false as const, error: result.error };
    }),
  );

  return NextResponse.json({ results });
}
