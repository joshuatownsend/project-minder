import { NextResponse } from "next/server";
import { existsSync, statSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const REPORT_DIR = join(homedir(), ".claude", "usage-data");
const REPORT_FILE = join(REPORT_DIR, "report.html");

// Strip <script> tags and inline event handlers (on*=...) as defense-in-depth.
// The report.html is generated locally by Claude Code, but we sanitize anyway.
function sanitize(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");
}

export async function GET() {
  // Containment check: ensure the resolved path stays within the expected dir
  const resolved = resolve(REPORT_FILE);
  if (!resolved.startsWith(resolve(REPORT_DIR))) {
    return NextResponse.json({ error: "Path traversal rejected" }, { status: 400 });
  }

  if (!existsSync(resolved)) {
    return NextResponse.json({
      exists: false,
      mtime: null,
      sizeBytes: null,
      html: null,
    });
  }

  const stat = statSync(resolved);
  const raw = readFileSync(resolved, "utf-8");
  const html = sanitize(raw);

  return NextResponse.json({
    exists: true,
    mtime: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    html,
  });
}
