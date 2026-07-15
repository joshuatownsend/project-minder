import "server-only";
import { NextResponse } from "next/server";
import { demoMode } from "./demoMode";

/**
 * Write-path guard for demo mode. In demo mode every project resolves to a
 * synthetic `C:\dev\<slug>` path that doesn't exist on disk, so a mutating route
 * that resolves a slug and hands the path to a file writer would create files
 * under fake paths (or `~/.claude/projects/C--dev-…`), breaking the "demo
 * creates no files / touches nothing" promise. Project-scoped write routes call
 * this first and return the 409 when it's non-null.
 *
 *   const blocked = await demoWriteBlock();
 *   if (blocked) return blocked;
 */
export async function demoWriteBlock(): Promise<NextResponse | null> {
  if (await demoMode()) {
    return NextResponse.json({ error: "Read-only in demo mode." }, { status: 409 });
  }
  return null;
}
