import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { DB_DIR } from "@/lib/db/connection";
import { withFileLock, writeFileAtomic, chmodSecure } from "@/lib/atomicWrite";

const SECRETS_PATH = path.join(DB_DIR, "secrets.json");

type SecretsMap = Record<string, string>;

const g = globalThis as unknown as { __minderSecrets?: SecretsMap };

async function readSecrets(): Promise<SecretsMap> {
  if (g.__minderSecrets) return g.__minderSecrets;
  try {
    const raw = await fs.readFile(SECRETS_PATH, "utf8");
    g.__minderSecrets = JSON.parse(raw) as SecretsMap;
  } catch {
    g.__minderSecrets = {};
  }
  return g.__minderSecrets;
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
    await chmodSecure(SECRETS_PATH);
  });
  // Invalidate cache so next read reflects the write.
  delete g.__minderSecrets;
}

export async function deleteSecret(key: string): Promise<void> {
  await withFileLock(SECRETS_PATH, async () => {
    let secrets: SecretsMap = {};
    try {
      const raw = await fs.readFile(SECRETS_PATH, "utf8");
      secrets = JSON.parse(raw) as SecretsMap;
    } catch {
      // File missing or corrupt — nothing to delete.
    }
    delete secrets[key];
    await writeFileAtomic(SECRETS_PATH, JSON.stringify(secrets, null, 2));
    await chmodSecure(SECRETS_PATH);
  });
  delete g.__minderSecrets;
}

export async function listSecretMetadata(): Promise<{ keys: string[]; mtime: string | null }> {
  try {
    const [stat, secrets] = await Promise.all([fs.stat(SECRETS_PATH), readSecrets()]);
    return { keys: Object.keys(secrets), mtime: stat.mtime.toISOString() };
  } catch {
    return { keys: [], mtime: null };
  }
}
