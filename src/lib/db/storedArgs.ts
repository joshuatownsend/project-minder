import "server-only";

// Shared deserializer for `tool_uses.arguments_json`. Both the ingest
// path (rehydrating one session for one-shot recomputation on tail
// append) and the read-side data façade (rehydrating filtered turns for
// `/api/usage`) need it; pulling it into a shared module keeps the
// recovery regex and JSON-fallback logic in one place so a fix or
// loosening of the recovery rules can't drift between sites.

// Capture everything after `"command":"` up to the first non-escaped
// `"` or end of string. The fallback only recovers `command` because
// that's the single field one-shot detection reads — it's the one
// argument we can't afford to lose when the stored JSON was truncated
// past a value boundary. Other fields can stay missing.
const COMMAND_RECOVERY_RE = /"command"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/;

/**
 * Parse `tool_uses.arguments_json` from the DB. Tries `JSON.parse` first
 * (the common case); on failure, regex-recovers the `command` field so
 * `detectOneShot` can still see Bash / PowerShell verification commands
 * when the stored JSON was truncated past the boundary of the `command`
 * value.
 */
export function parseStoredArgs(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    const match = COMMAND_RECOVERY_RE.exec(json);
    if (!match) return undefined;
    try {
      const recovered = JSON.parse(`"${match[1]}"`) as string;
      return { command: recovered };
    } catch {
      return undefined;
    }
  }
}
