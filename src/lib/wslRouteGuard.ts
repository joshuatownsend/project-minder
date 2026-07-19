import { NextResponse } from "next/server";
import { firstBlockedWslPath, WslUnavailableError } from "./wsl";

/**
 * Route-level never-wake guard: 503s when any supplied path sits under a WSL
 * distro that isn't running (touching it would auto-start the VM), else null.
 * Non-WSL paths cost nothing — the check sync-parses before any wsl.exe call.
 */
export async function wslGuardResponse(
  ...paths: (string | undefined)[]
): Promise<NextResponse | null> {
  const blocked = await firstBlockedWslPath(...paths);
  if (!blocked) return null;
  return NextResponse.json(
    { error: new WslUnavailableError(blocked).message },
    { status: 503 }
  );
}
