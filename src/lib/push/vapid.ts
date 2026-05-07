import "server-only";
import path from "path";
import { promises as fs } from "fs";
import webpush from "web-push";
import { DB_DIR } from "@/lib/db/connection";
import { withFileLock, writeFileAtomic } from "@/lib/atomicWrite";

const VAPID_KEYS_PATH = path.join(DB_DIR, "vapid-keys.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const g = globalThis as unknown as { __minderVapid?: VapidKeys };

export async function getOrCreateVapidKeys(): Promise<VapidKeys> {
  if (g.__minderVapid) return g.__minderVapid;

  const keys = await withFileLock(VAPID_KEYS_PATH, async () => {
    // Re-check inside lock: another process may have written between our
    // check and acquiring the lock.
    try {
      const raw = await fs.readFile(VAPID_KEYS_PATH, "utf8");
      return JSON.parse(raw) as VapidKeys;
    } catch {
      // File doesn't exist or is corrupt — generate fresh keys.
    }
    const generated = webpush.generateVAPIDKeys();
    const data: VapidKeys = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    };
    await writeFileAtomic(VAPID_KEYS_PATH, JSON.stringify(data, null, 2));
    try {
      await fs.chmod(VAPID_KEYS_PATH, 0o600);
    } catch {
      // No-op on Windows — NTFS ACL cannot be set via fs.chmod.
    }
    return data;
  });

  g.__minderVapid = keys;
  return keys;
}
