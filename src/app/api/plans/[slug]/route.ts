import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { scanClaudePlans } from "@/lib/scanner/claudePlans";

const PLANS_DIR = path.join(os.homedir(), ".claude", "plans");

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!slug || /[/\\]/.test(slug)) {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }

  const filePath = path.join(PLANS_DIR, `${slug}.md`);
  // Ensure we haven't escaped the plans dir via a crafted slug
  if (!filePath.startsWith(PLANS_DIR)) {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }

  try {
    const [body, plans] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      scanClaudePlans(),
    ]);
    const meta = plans.find((p) => p.slug === slug);
    if (!meta) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ...meta, body });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
