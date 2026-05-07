import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { DB_DIR } from "@/lib/db/connection";
import { withFileLock, writeFileAtomic } from "@/lib/atomicWrite";

const SECRETS_PATH = path.join(DB_DIR, "secrets.json");

type SecretsMap = Record<string, string>;

let cachedSecrets: SecretsMap | null = null;

async function readSecrets(): Promise<SecretsMap> {
  if (cachedSecrets) return cachedSecrets;
  try {
    const raw = await fs.readFile(SECRETS_PATH, "utf8");
    cachedSecrets = JSON.parse(raw) as SecretsMap;
  } catch {
    cachedSecrets = {};
  }
  return cachedSecrets;
}

export async function getSecret(key: string): Promise<string | undefined> {
  const secrets = await readSecrets();
  return secrets[key];
}

export async function setSecret(key: string, value: string): Promise<void> {
  await withFileLock(SECRETS_PATH, async () => {
    let secrets: SecretsMap = {};
    try {
      const raw = await fs.readFile(SECRETS_PATH, "utf8");
      secrets = JSON.parse(raw) as SecretsMap;
    } catch {
      // File missing or corrupt — start fresh.
    }
    secrets[key] = value;
    await writeFileAtomic(SECRETS_PATH, JSON.stringify(secrets, null, 2));
    try {
      await fs.chmod(SECRETS_PATH, 0o600);
    } catch {
      // No-op on Windows — inherits parent dir NTFS ACL.
    }
  });
  // Invalidate cache so next read reflects the write.
  cachedSecrets = null;
}

export async function listSecretMetadata(): Promise<{ keys: string[]; mtime: string | null }> {
  try {
    const stat = await fs.stat(SECRETS_PATH);
    const secrets = await readSecrets();
    return { keys: Object.keys(secrets), mtime: stat.mtime.toISOString() };
  } catch {
    return { keys: [], mtime: null };
  }
}
