import { listAdapters, getEnabledAdapters } from "@/lib/adapters";
import { readConfig as readMinderConfig } from "@/lib/config";

// Harness catalog. Each entry additionally reports `enabled` (in
// enabledAdapters) and `hasConfig` (exposes a read-only config surface, item 1)
// so the /adapters view can offer a selector. Array shape preserved for the
// existing Settings consumer, which ignores the extra fields.
export async function GET() {
  const config = await readMinderConfig();
  const enabledIds = new Set(getEnabledAdapters(config).map((a) => a.id));
  const adapters = listAdapters().map((a) => ({
    id: a.id,
    displayName: a.displayName,
    enabled: enabledIds.has(a.id),
    hasConfig: typeof a.readConfig === "function",
  }));
  return Response.json(adapters);
}
