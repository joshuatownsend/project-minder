import { NextResponse } from "next/server";
import { discoverWslSuggestions } from "@/lib/wsl";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { demoModeEnv } from "@/lib/demo/demoMode";

/**
 * GET /api/wsl — WSL distro discovery for the Settings scan-roots UI.
 *
 * Returns `{ available, distros: [{ name, state, isDefault, suggestedRoots,
 * claudeHomes }] }`. Read-only: enumerating distros goes through `wsl.exe -l -v`
 * (which never starts a VM); filesystem probing for dev/.claude candidates
 * happens only inside distros that are already Running.
 */
export async function GET() {
  // Demo mode never probes the host environment — deterministic empty result,
  // matching the demo guards on the other read surfaces.
  const config = await readConfig();
  if (demoModeEnv() || getFlag(config.featureFlags, "demoMode", false)) {
    return NextResponse.json({ available: false, distros: [] });
  }
  const discovery = await discoverWslSuggestions();
  return NextResponse.json(discovery);
}
