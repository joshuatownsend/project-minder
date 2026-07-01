import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { readConfig } from "@/lib/config";
import { listTemplates } from "@/lib/template/registry";
import type { TemplatesListResult } from "@/lib/queryOptions";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/**
 * Shared `/api/templates` (GET) response computation, used by both the route and
 * the RSC prefetch. Lists every valid template manifest under
 * `<devRoot>/.minder/templates/` plus any per-template parse errors.
 */
export async function loadTemplatesResponse(): Promise<TemplatesListResult> {
  const config = await readConfig();
  const { manifests, errors } = await listTemplates(config);
  return { manifests, errors };
}

/** Prefetch the live template manifests list. */
export async function prefetchTemplates(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.templates(),
    queryFn: async () => jsonClone(await loadTemplatesResponse()),
  });
}
