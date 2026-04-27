import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { LockfileEntry } from "./types";

interface LockfileFile {
  version?: number;
  skills?: Record<string, LockfileEntry>;
}

export async function loadLockfile(): Promise<Map<string, LockfileEntry>> {
  const lockPath = path.join(os.homedir(), ".agents", ".skill-lock.json");
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
