import "server-only";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { withFileLock, writeFileAtomic } from "@/lib/atomicWrite";
import { recordPreWrite } from "@/lib/configHistory";
import { tryParseJsonc } from "@/lib/scanner/util/jsonc";

const USER_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

// The six env vars that constitute a Project Minder OTEL installation.
// OTEL_METRICS_EXPORTER and OTEL_LOGS_EXPORTER must be set to "otlp" — without
// them the SDK defaults to no-op exporters and sends nothing regardless of the
// endpoint configuration. OTEL_EXPORTER_OTLP_PROTOCOL must be "http/json"
// because our ingest endpoint does not support gRPC or protobuf.
const OTEL_ENV_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_LOG_TOOL_DETAILS",
] as const;

async function readUserSettings(p: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = tryParseJsonc<Record<string, unknown>>(raw);
    if (parsed === null) throw new Error(`${p} is malformed JSON — fix the file before retrying`);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export interface OtelInstallStatus {
  installed: boolean;
  endpoint: string | null;
}

/**
 * Returns the current OTEL install status by reading ~/.claude/settings.json.
 * "Installed" means all six env vars are present.
 */
export async function getOtelInstallStatus(): Promise<OtelInstallStatus> {
  const doc = await readUserSettings(USER_SETTINGS_PATH);
  const env = (doc.env ?? {}) as Record<string, unknown>;
  const installed = OTEL_ENV_KEYS.every((k) => typeof env[k] === "string" && (env[k] as string).length > 0);
  const endpoint = typeof env["OTEL_EXPORTER_OTLP_ENDPOINT"] === "string"
    ? (env["OTEL_EXPORTER_OTLP_ENDPOINT"] as string)
    : null;
  return { installed, endpoint };
}

/**
 * Write OTEL env vars into ~/.claude/settings.json.
 * Idempotent — re-running with the same endpoint just overwrites with the same values.
 * Atomic write with COW snapshot.
 */
export async function installOtelEnv(endpoint: string): Promise<void> {
  await withFileLock(USER_SETTINGS_PATH, async () => {
    const doc = await readUserSettings(USER_SETTINGS_PATH);
    if (!doc.env || typeof doc.env !== "object") doc.env = {};
    const env = doc.env as Record<string, string>;
    env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1";
    env["OTEL_METRICS_EXPORTER"] = "otlp";
    env["OTEL_LOGS_EXPORTER"] = "otlp";
    env["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint;
    env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/json";
    env["OTEL_LOG_TOOL_DETAILS"] = "1";
    await recordPreWrite(USER_SETTINGS_PATH, { label: "installOtelEnv" });
    await fs.mkdir(path.dirname(USER_SETTINGS_PATH), { recursive: true });
    await writeFileAtomic(USER_SETTINGS_PATH, JSON.stringify(doc, null, 2) + "\n");
  });
}

/**
 * Remove Project Minder OTEL env vars from ~/.claude/settings.json.
 * Leaves any other env vars untouched. No-op if already absent.
 * Atomic write with COW snapshot.
 */
export async function removeOtelEnv(): Promise<void> {
  await withFileLock(USER_SETTINGS_PATH, async () => {
    const doc = await readUserSettings(USER_SETTINGS_PATH);
    if (!doc.env || typeof doc.env !== "object") return;
    const env = doc.env as Record<string, unknown>;
    let changed = false;
    for (const key of OTEL_ENV_KEYS) {
      if (key in env) {
        delete env[key];
        changed = true;
      }
    }
    if (!changed) return;
    await recordPreWrite(USER_SETTINGS_PATH, { label: "removeOtelEnv" });
    await writeFileAtomic(USER_SETTINGS_PATH, JSON.stringify(doc, null, 2) + "\n");
  });
}
