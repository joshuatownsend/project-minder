/**
 * The only endpoints the stored LLM key may be sent to: HTTPS, or plain HTTP to this machine
 * (a local model server). Shared by the config route, the test route and the callers that attach
 * the key, so a request-supplied URL cannot route the key elsewhere (#630).
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isValidLlmEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string") return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
}

/** True for Anthropic's own API hosts (matched on the parsed hostname, not a substring of the URL). */
export function isAnthropicHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === "anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}
