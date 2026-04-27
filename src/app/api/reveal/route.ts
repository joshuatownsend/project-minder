import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import { readConfig, getDevRoots } from "@/lib/config";

const execFileAsync = promisify(execFile);

function getAllowedRoots(): string[] {
  return [
    path.join(os.homedir(), ".claude"),
    path.join(os.homedir(), ".agents"),
  ];
}

function isPathAllowed(targetPath: string, allowedRoots: string[]): boolean {
  const resolved = path.resolve(targetPath);
  return allowedRoots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export async function POST(request: NextRequest) {
  let body: { path?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const targetPath = body.path;
  if (!targetPath || typeof targetPath !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  // Extend allowed roots with all configured dev roots
  const config = await readConfig();
  const devRoots = getDevRoots(config);
  const allowedRoots = [...getAllowedRoots(), ...devRoots];

  if (!isPathAllowed(targetPath, allowedRoots)) {
    return NextResponse.json({ error: "Path not in allowed roots" }, { status: 403 });
  }

  try {
    const platform = process.platform;
    if (platform === "win32") {
      await execFileAsync("explorer", [`/select,${targetPath}`], { timeout: 5_000 });
    } else if (platform === "darwin") {
      await execFileAsync("open", ["-R", targetPath], { timeout: 5_000 });
    } else {
      await execFileAsync("xdg-open", [path.dirname(targetPath)], { timeout: 5_000 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    // explorer sometimes exits non-zero even on success; treat as ok
    return NextResponse.json({ ok: true });
  }
}
