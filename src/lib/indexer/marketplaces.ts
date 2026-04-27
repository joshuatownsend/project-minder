import { promises as fs } from "fs";
import path from "path";
import os from "os";

interface KnownMarketplaceEntry {
  source?: { repo?: string };
  installLocation?: string;
  lastUpdated?: string;
}

// Returns Map<marketplaceName, "owner/repo">
export async function loadKnownMarketplaces(): Promise<Map<string, string>> {
  const p = path.join(os.homedir(), ".claude", "plugins", "known_marketplaces.json");
  try {
    const raw = await fs.readFile(p, "utf-8");
    const data = JSON.parse(raw) as Record<string, KnownMarketplaceEntry>;
    const map = new Map<string, string>();
    for (const [name, entry] of Object.entries(data)) {
      if (entry.source?.repo) {
        map.set(name, entry.source.repo);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}
