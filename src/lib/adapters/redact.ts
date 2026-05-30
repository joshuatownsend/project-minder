// Secret redaction for read-only harness config surfaces (item 1).
//
// Harness configs (e.g. Codex's config.toml) carry live secrets: bearer
// tokens in `http_headers`, API keys in `[mcp_servers.X.env]`, tokens embedded
// in URLs. A key-name denylist alone leaks the next secret under an innocent
// key (`url`, `source`) or in an unlisted table (`env`). So redaction works on
// the PARSED OBJECT with three overlapping defenses, and the structured result
// is what the UI renders — raw secret-bearing text never leaves the server.
//
// Defenses:
//   1. Secret TABLES — any object under a key like `http_headers`/`env`/`auth`
//      has ALL its leaf values blanked (keys kept, so the user still sees what
//      is configured).
//   2. Secret KEYS — a scalar (or whole subtree) under an obviously-secret key
//      is blanked.
//   3. Value SHAPE — any remaining string that looks like a token/JWT/long hex
//      is blanked, catching secrets hiding under innocent keys.

export const REDACTED = "<redacted>";

// Object keys whose ENTIRE value (all nested leaves) is secret.
const SECRET_TABLE_KEYS = new Set([
  "http_headers",
  "headers",
  "env",
  "environment",
  "auth",
  "credentials",
  "secrets",
]);

// Scalar keys whose value is a secret.
const SECRET_KEY_RE =
  /^(authorization|api[_-]?key|apikey|secret|token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|password|passwd|pwd|private[_-]?key|cookie|bearer)$/i;

// Value shapes that are secrets regardless of their key: bearer tokens, OpenAI
// `sk-` keys, Neon `napi_`, GitHub `gh?_`, JWTs, and long hex/base64 blobs.
const SECRET_VALUE_RE =
  /(bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|napi_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9._-]{20,}|\b[A-Fa-f0-9]{40,}\b)/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Replace every scalar leaf in a subtree with REDACTED, preserving structure
 *  (keys, array shape) so the consumer still sees what's configured. */
function blankLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankLeaves);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = blankLeaves(v);
    return out;
  }
  return REDACTED;
}

function redactString(value: string): string {
  return SECRET_VALUE_RE.test(value) ? REDACTED : value;
}

/**
 * Recursively redact secrets from a parsed config object. Returns a new value;
 * the input is not mutated. Apply this to the parsed TOML/JSON object BEFORE it
 * is serialized or rendered.
 */
export function redactConfig(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactConfig);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (SECRET_TABLE_KEYS.has(lower)) {
        out[key] = blankLeaves(v); // whole table is secret
      } else if (SECRET_KEY_RE.test(key)) {
        out[key] = isPlainObject(v) || Array.isArray(v) ? blankLeaves(v) : REDACTED;
      } else {
        out[key] = redactConfig(v); // recurse; string leaves hit the shape check
      }
    }
    return out;
  }
  return value; // number / boolean / null
}
