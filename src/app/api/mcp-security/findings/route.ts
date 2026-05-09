import { NextRequest } from "next/server";
import { getAllFindings, getLatestRun } from "@/lib/scanner/mcp-security/store";
import { runMcpSecurityScan } from "@/lib/scanner/mcp-security/index";
import { jsonWithCacheControl } from "@/lib/httpCache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const serverId = searchParams.get("serverId") ?? undefined;
  const fresh = searchParams.get("refresh") === "1";

  // Trigger a scan if forced or no run exists yet; reuse the result to avoid a second DB call.
  let latestRun = fresh ? null : await getLatestRun();
  if (fresh) {
    await runMcpSecurityScan("manual");
    latestRun = await getLatestRun();
  } else if (!latestRun) {
    await runMcpSecurityScan("scan");
    latestRun = await getLatestRun();
  }

  const findings = await getAllFindings(serverId, latestRun?.id);

  return jsonWithCacheControl(
    {
      findings,
      lastRunAt: latestRun?.startedAtMs ?? null,
      durationMs: latestRun?.durationMs ?? null,
      serversScanned: latestRun?.serversScanned ?? 0,
    },
    fresh ? "no-store" : "private, max-age=60"
  );
}
