import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { LockfileEntry } from "./types";

interface LockfileFile {
  version?: number;
  skills?: Record<string, LockfileEntry>;
}

/**
 * The skills lockfile beside a Claude home: `~/.agents/.skill-lock.json`, i.e.
 * the `.agents` sibling of the `.claude` directory. `home` is the `.claude`
 * path; defaults to this machine's.
 */
export async function loadLockfile(home?: string): Promise<Map<string, LockfileEntry>> {
  const base = home ? path.dirname(home) : os.homedir();
  const lockPath = path.join(base, ".agents", ".skill-lock.json");
  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    const data = JSON.parse(raw) as LockfileFile;
    const skills = data.skills ?? {};
    const map = new Map<string, LockfileEntry>();
    for (const [name, entry] of Object.entries(skills)) {
      if (entry && typeof entry.sourceUrl === "string") {
        map.set(name, entry);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}
