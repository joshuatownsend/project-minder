import { NextResponse } from "next/server";
import { discoverWslSuggestions } from "@/lib/wsl";

/**
 * GET /api/wsl — WSL distro discovery for the Settings scan-roots UI.
 *
 * Returns `{ available, distros: [{ name, state, isDefault, suggestedRoots,
 * claudeHomes }] }`. Read-only: enumerating distros goes through `wsl.exe -l -v`
 * (which never starts a VM); filesystem probing for dev/.claude candidates
 * happens only inside distros that are already Running.
 */
export async function GET() {
  const discovery = await discoverWslSuggestions();
  return NextResponse.json(discovery);
}
