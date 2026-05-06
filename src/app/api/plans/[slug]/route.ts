import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseFrontmatter } from "@/lib/indexer/parseFrontmatter";

const PLANS_DIR = path.join(os.homedir(), ".claude", "plans");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!slug || /[/\\]/.test(slug)) {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }

  const filePath = path.join(PLANS_DIR, `${slug}.md`);
  if (!filePath.startsWith(PLANS_DIR)) {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }

  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);

    const { fm, body } = parseFrontmatter(raw);

    const title =
      typeof fm.title === "string" && fm.title.trim()
        ? fm.title.trim()
        : body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;

    const rawTags = fm.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((t): t is string => typeof t === "string")
      : typeof rawTags === "string"
      ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const relatedSessionIds = [
      ...new Set([...body.matchAll(UUID_RE)].map((m) => m[0].toLowerCase())),
    ];

    return NextResponse.json({
      slug,
      path: filePath,
      title,
      tags,
      relatedSessionIds,
      mtime: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      body,
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
