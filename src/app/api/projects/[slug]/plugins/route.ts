import { NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { scanProjectPluginEnables } from "@/lib/scanner/projectPlugins";
import { loadInstalledPlugins } from "@/lib/indexer/walkPlugins";

/** Returns the project's enabledPlugins entries, decorated with whether each
 *  is actually installed at user scope. Used by the MarkAsTemplateModal unit
 *  picker so the user can pick plugin enables for a template. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: `No project "${slug}".` } }, { status: 404 });
  }

  const [enables, installed] = await Promise.all([
    scanProjectPluginEnables(project.path),
    loadInstalledPlugins(),
  ]);
  const installedKeys = new Set(
    installed.map((p) => (p.marketplace ? `${p.pluginName}@${p.marketplace}` : p.pluginName))
  );
  const decorated = enables.map((e) => ({
    ...e,
    installed: installedKeys.has(e.key),
  }));
  return NextResponse.json({ enables: decorated });
}
