import type { SessionAdapter, SessionFile } from "./types";
import type { MinderConfig } from "@/lib/types";
import claudeAdapter from "./claude";

const REGISTRY = new Map<string, SessionAdapter>();

function register(adapter: SessionAdapter): void {
  REGISTRY.set(adapter.id, adapter);
}

register(claudeAdapter);

export function listAdapters(): SessionAdapter[] {
  return [...REGISTRY.values()];
}

export function getAdapter(id: string): SessionAdapter | undefined {
  return REGISTRY.get(id);
}

export function getAdapterDisplayNameMap(): Map<string, string> {
  return new Map([...REGISTRY.entries()].map(([id, a]) => [id, a.displayName]));
}

const _warnedUnknown = new Set<string>();

export function getEnabledAdapters(config: MinderConfig): SessionAdapter[] {
  const ids = config.enabledAdapters ?? ["claude"];
  const result: SessionAdapter[] = [];

  for (const id of ids) {
    const adapter = REGISTRY.get(id);
    if (!adapter) {
      if (!_warnedUnknown.has(id)) {
        console.warn(
          `[adapters] Unknown adapter id "${id}" in enabledAdapters config. ` +
            `Known adapters: ${[...REGISTRY.keys()].join(", ")}`
        );
        _warnedUnknown.add(id);
      }
      continue;
    }
    result.push(adapter);
  }

  return result;
}

export async function discoverAllSessions(
  config: MinderConfig
): Promise<SessionFile[]> {
  const adapters = getEnabledAdapters(config);
  const results = await Promise.all(adapters.map((a) => a.discover()));
  return results.flat();
}

export type { SessionAdapter, SessionFile };
