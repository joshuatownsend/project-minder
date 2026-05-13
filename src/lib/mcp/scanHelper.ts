import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import type { ScanResult } from "@/lib/types";

// Single-flight wrapper around `scanAllProjects()` for MCP tools. Without
// this, 5 tool calls firing back-to-back before the scan cache warms would
// each spawn a full `C:\dev\*` dir walk in parallel — same pattern the
// `/api/projects` route handler protects with its own `scanInProgress`
// module-local promise. Stored on globalThis so HMR doesn't lose the lock.
const g = globalThis as unknown as { __minderMcpScanInFlight?: Promise<ScanResult> };

export async function getCachedOrFreshScan(): Promise<ScanResult> {
  const cached = getCachedScan();
  if (cached) return cached;
  if (g.__minderMcpScanInFlight) return g.__minderMcpScanInFlight;

  g.__minderMcpScanInFlight = scanAllProjects()
    .then((fresh) => {
      setCachedScan(fresh);
      return fresh;
    })
    .finally(() => {
      g.__minderMcpScanInFlight = undefined;
    });

  return g.__minderMcpScanInFlight;
}
