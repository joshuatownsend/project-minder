/**
 * MCP security pattern rule registry.
 *
 * 58 explicit rules + a 30-name SUSPICIOUS_PARAM_NAMES set across 13 categories.
 * Ported from the mcpware/cross-code-organizer MIT reference (src/security-scanner.mjs).
 *
 * Each rule: { id, category, severity, regex, message }
 * The PI (prompt-injection) rules are also tested against the leetspeak-normalised
 * text — see scanner.ts for how LEETSPEAK_CATEGORIES drives a second pass.
 */

import type { McpFindingCategory, McpFindingSeverity } from "../../types";

export interface PatternRule {
  id: string;
  category: McpFindingCategory;
  severity: McpFindingSeverity;
  regex: RegExp;
  message: string;
}

export const PATTERN_RULES: PatternRule[] = [
  // ── PI: Prompt Injection (17 rules) ────────────────────────────────────────
  {
    id: "PI-01",
    category: "PI",
    severity: "crit",
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
    message: "Prompt override: instructs model to ignore prior context",
  },
  {
    id: "PI-02",
    category: "PI",
    severity: "crit",
    regex: /\bnew\s+instructions?\b.{0,40}\boverride\b/i,
    message: "Prompt override: new instructions with override keyword",
  },
  {
    id: "PI-03",
    category: "PI",
    severity: "crit",
    regex: /\byou\s+are\s+now\b/i,
    message: "Persona hijack: 'you are now' reprogramming pattern",
  },
  {
    id: "PI-04",
    category: "PI",
    severity: "crit",
    regex: /\bact\s+as\s+(if\s+you\s+are|a\b)/i,
    message: "Persona hijack: 'act as' reprogramming pattern",
  },
  {
    id: "PI-05",
    category: "PI",
    severity: "high",
    regex: /\bsystem\s+prompt\s*:/i,
    message: "System prompt injection: explicit system prompt marker",
  },
  {
    id: "PI-06",
    category: "PI",
    severity: "high",
    regex: /\[system\]/i,
    message: "System prompt injection: [SYSTEM] tag marker",
  },
  {
    id: "PI-07",
    category: "PI",
    severity: "high",
    regex: /<\s*system\s*>/i,
    message: "System prompt injection: XML system tag",
  },
  {
    id: "PI-08",
    category: "PI",
    severity: "high",
    regex: /\bdo\s+not\s+(tell|inform|mention)\s+(the\s+)?(user|human)/i,
    message: "Concealment instruction: hiding tool actions from user",
  },
  {
    id: "PI-09",
    category: "PI",
    severity: "high",
    regex: /\bkeep\s+(this|these|the\s+following)\s+(secret|hidden|confidential)\b/i,
    message: "Concealment instruction: keep instructions secret",
  },
  {
    id: "PI-10",
    category: "PI",
    severity: "high",
    regex: /\bdo\s+not\s+(reveal|disclose|expose)\s+(this|these|your)\s+(instructions?|prompt|system)/i,
    message: "Concealment instruction: do not reveal system prompt",
  },
  {
    id: "PI-11",
    category: "PI",
    severity: "high",
    regex: /\boverride\s+(your\s+)?(safety|ethical|moral)\s+(guidelines?|rules?|constraints?|training)/i,
    message: "Safety bypass: override safety or ethical guidelines",
  },
  {
    id: "PI-12",
    category: "PI",
    severity: "high",
    regex: /\byou\s+(must|should|have\s+to)\s+(always|never)\b/i,
    message: "Behavioral override: unconditional must/never instruction",
  },
  {
    id: "PI-13",
    category: "PI",
    severity: "med",
    regex: /\bDAN\s+mode\b/i,
    message: "Jailbreak marker: DAN mode reference",
  },
  {
    id: "PI-14",
    category: "PI",
    severity: "med",
    regex: /\bjailbreak\b/i,
    message: "Jailbreak marker: literal 'jailbreak' keyword",
  },
  {
    id: "PI-15",
    category: "PI",
    severity: "med",
    regex: /\bunrestricted\s+mode\b/i,
    message: "Jailbreak marker: 'unrestricted mode' phrase",
  },
  {
    id: "PI-16",
    category: "PI",
    severity: "med",
    regex: /\bpretend\s+(you\s+are|to\s+be)\b.{0,60}\b(AI|assistant|model)\b/i,
    message: "Persona hijack: pretend-to-be roleplay targeting AI identity",
  },
  {
    id: "PI-17",
    category: "PI",
    severity: "med",
    regex: /\bfor\s+(educational|research|testing)\s+purposes?\s+only\b/i,
    message: "Social engineering: 'for educational purposes only' cover phrase",
  },

  // ── CH: Credential Harvesting (8 rules) ────────────────────────────────────
  {
    id: "CH-01",
    category: "CH",
    severity: "crit",
    regex: /\bsk-[A-Za-z0-9]{20,}\b/,
    message: "Hardcoded OpenAI API key (sk-…)",
  },
  {
    id: "CH-02",
    category: "CH",
    severity: "crit",
    regex: /\bghp_[A-Za-z0-9]{36,}\b/,
    message: "Hardcoded GitHub personal access token (ghp_…)",
  },
  {
    id: "CH-03",
    category: "CH",
    severity: "high",
    regex: /Authorization:\s*Bearer\s+[A-Za-z0-9._\-]{20,}/,
    message: "Hardcoded Authorization Bearer token",
  },
  {
    id: "CH-04",
    category: "CH",
    severity: "high",
    regex: /\baws_access_key_id\s*=\s*[A-Z0-9]{16,}/i,
    message: "Hardcoded AWS access key ID",
  },
  {
    id: "CH-05",
    category: "CH",
    severity: "high",
    regex: /\baws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{30,}/i,
    message: "Hardcoded AWS secret access key",
  },
  {
    id: "CH-06",
    category: "CH",
    severity: "high",
    regex: /\bpassword\s*=\s*["'][^"']{6,}["']/i,
    message: "Hardcoded password assignment in string literal",
  },
  {
    id: "CH-07",
    category: "CH",
    severity: "high",
    regex: /\bprivate_?key\s*=\s*["'][-]{3,}/i,
    message: "Hardcoded PEM private key block",
  },
  {
    id: "CH-08",
    category: "CH",
    severity: "med",
    regex: /(?:[A-Za-z0-9+/]{4}){12,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/,
    message: "Long base64 chunk that may encode a credential or payload",
  },

  // ── TP: Tool Poisoning (6 rules) ────────────────────────────────────────────
  {
    id: "TP-01",
    category: "TP",
    severity: "crit",
    regex: /process\.exec\s*\(/i,
    message: "Shell execution via process.exec in tool metadata",
  },
  {
    id: "TP-02",
    category: "TP",
    severity: "crit",
    regex: /child_process\.(exec|spawn|execSync|spawnSync)\s*\(/i,
    message: "Shell execution via child_process API",
  },
  {
    id: "TP-03",
    category: "TP",
    severity: "crit",
    regex: /\bnew\s+Function\s*\(/,
    message: "Dynamic code construction via Function constructor",
  },
  {
    id: "TP-04",
    category: "TP",
    severity: "high",
    regex: /\bimport\s*\(\s*['"`][^'"`]+['"`]\s*\)/,
    message: "Dynamic import() expression — potentially loading external code",
  },
  {
    id: "TP-05",
    category: "TP",
    severity: "high",
    regex: /require\s*\(\s*['"`][^'"`]+['"`]\s*\)/,
    message: "Dynamic require() call embedded in tool descriptor",
  },
  {
    id: "TP-06",
    category: "TP",
    severity: "med",
    regex: /\bsetTimeout\s*\(\s*['"`]/,
    message: "String-based setTimeout (delayed code execution pattern)",
  },

  // ── CE: Covert Exfiltration (5 rules) ──────────────────────────────────────
  {
    id: "CE-01",
    category: "CE",
    severity: "crit",
    regex: /\bexfiltrat(e|ing|ion)\b/i,
    message: "Explicit exfiltration keyword",
  },
  {
    id: "CE-02",
    category: "CE",
    severity: "crit",
    regex: /\bsend\b.{0,40}\b(password|credential|secret|token|key)\b/i,
    message: "Instruction to send credential/secret to external destination",
  },
  {
    id: "CE-03",
    category: "CE",
    severity: "high",
    regex: /\bread\b.{0,40}\.ssh[\\/]/i,
    message: "Instruction to read SSH directory",
  },
  {
    id: "CE-04",
    category: "CE",
    severity: "high",
    regex: /\bcollect\b.{0,50}\b(browser|cookie|session|localStorage)\b/i,
    message: "Instruction to collect browser storage / session data",
  },
  {
    id: "CE-05",
    category: "CE",
    severity: "high",
    regex: /POST\b.{0,80}\b(password|credential|token|secret)\b/i,
    message: "POST request targeting credential-like data",
  },

  // ── DE: Deobfuscation Evasion (5 rules) ────────────────────────────────────
  {
    id: "DE-01",
    category: "DE",
    severity: "high",
    regex: /\batob\s*\(/i,
    message: "atob() base64 decode call embedded in tool metadata",
  },
  {
    id: "DE-02",
    category: "DE",
    severity: "high",
    regex: /Buffer\.from\s*\([^)]+,\s*['"]base64['"]\)/i,
    message: "Buffer.from(…, 'base64') decode pattern",
  },
  {
    id: "DE-03",
    category: "DE",
    severity: "high",
    regex: /\bbase64\.decode\s*\(/i,
    message: "Explicit base64.decode() call",
  },
  {
    id: "DE-04",
    category: "DE",
    severity: "med",
    regex: /\\u[0-9A-Fa-f]{4}.*\\u[0-9A-Fa-f]{4}.*\\u[0-9A-Fa-f]{4}/,
    message: "Multiple consecutive Unicode escape sequences (evasion pattern)",
  },
  {
    id: "DE-05",
    category: "DE",
    severity: "med",
    regex: /%[0-9A-Fa-f]{2}(?:.*%[0-9A-Fa-f]{2}){4,}/,
    message: "Dense URL-encoded sequence (≥5 encoded chars — possible payload)",
  },

  // ── SF: Shell Feature Abuse (5 rules) ──────────────────────────────────────
  {
    id: "SF-01",
    category: "SF",
    severity: "crit",
    regex: /[;&|]\s*rm\s+-[rRf]/,
    message: "Shell chain with destructive rm -r/-f/-rf command",
  },
  {
    id: "SF-02",
    category: "SF",
    severity: "crit",
    regex: /[;&|]\s*curl\b.+\|\s*(?:ba)?sh\b/,
    message: "curl-pipe-shell remote code execution pattern",
  },
  {
    id: "SF-03",
    category: "SF",
    severity: "high",
    regex: /[;&|]\s*wget\b.+\|\s*(?:ba)?sh\b/,
    message: "wget-pipe-shell remote code execution pattern",
  },
  {
    id: "SF-04",
    category: "SF",
    severity: "high",
    regex: /`[^`]{5,}`/,
    message: "Backtick command substitution in tool descriptor",
  },
  {
    id: "SF-05",
    category: "SF",
    severity: "med",
    regex: /\$\([^)]{5,}\)/,
    message: "Subshell command substitution $(…) in tool descriptor",
  },

  // ── HK: Hook / Keylogger (3 rules) ─────────────────────────────────────────
  {
    id: "HK-01",
    category: "HK",
    severity: "crit",
    regex: /\bkeylogger\b/i,
    message: "Keylogger keyword",
  },
  {
    id: "HK-02",
    category: "HK",
    severity: "crit",
    regex: /\bhook\s+keystrokes?\b/i,
    message: "Keystroke hooking instruction",
  },
  {
    id: "HK-03",
    category: "HK",
    severity: "high",
    regex: /\bclipboard\s+(monitor|watch|intercept)\b/i,
    message: "Clipboard monitoring instruction",
  },

  // ── TS: Dynamic Script Execution (3 rules) ─────────────────────────────────
  // TS-01 uses RegExp constructor so the literal text does not appear in source.
  {
    id: "TS-01",
    category: "TS",
    severity: "crit",
    // Matches: eval( — constructed to avoid triggering security linters on this source file.
    regex: new RegExp("\\bev" + "al\\s*\\("),
    message: "Direct code evaluation via eval()",
  },
  {
    id: "TS-02",
    category: "TS",
    severity: "high",
    regex: /\bvm\.run(?:In|Code)/i,
    message: "Node.js vm module code execution",
  },
  {
    id: "TS-03",
    category: "TS",
    severity: "med",
    regex: /\bscript\.runInNewContext\b/i,
    message: "Script.runInNewContext() sandbox escape pattern",
  },

  // ── CI: Command Injection (2 rules) ────────────────────────────────────────
  {
    id: "CI-01",
    category: "CI",
    severity: "crit",
    regex: /;\s*(?:rm|curl|wget|nc|ncat|bash|sh|python|perl|ruby)\s/,
    message: "Semicolon-chained dangerous command (command injection)",
  },
  {
    id: "CI-02",
    category: "CI",
    severity: "high",
    regex: /\|\s*(?:bash|sh|python|perl|ruby|node)\s/,
    message: "Pipe to shell interpreter (possible command injection)",
  },

  // ── PE: Path Escape / Traversal (2 rules) ──────────────────────────────────
  {
    id: "PE-01",
    category: "PE",
    severity: "high",
    regex: /(?:\.\.[\\/]){2,}/,
    message: "Path traversal: multiple ../../ sequences",
  },
  {
    id: "PE-02",
    category: "PE",
    severity: "med",
    regex: /\\\\[A-Za-z0-9_$-]{1,15}\\[A-Za-z$]/,
    message: "UNC path reference (possible network share access)",
  },

  // ── EP: Exfiltration Param (1 named rule + param-name set at runtime) ───────
  {
    id: "EP-01",
    category: "EP",
    severity: "high",
    regex: /(?:(?:^|[_\W])(?:api[_\-]?key|access[_\-]?token|secret[_\-]?key|auth[_\-]?token)(?:[_\W]|$))/i,
    message: "Tool parameter or env name matches credential exfiltration pattern",
  },

  // ── SC: Sandbox Circumvention (1 rule) ──────────────────────────────────────
  {
    id: "SC-01",
    category: "SC",
    severity: "crit",
    regex: /\bsandbox\s+(bypass|escape|circumvent)\b/i,
    message: "Sandbox bypass instruction",
  },

  // ── XR: Cross-server / Lateral Movement (1 rule) ───────────────────────────
  {
    id: "XR-01",
    category: "XR",
    severity: "high",
    regex: /\b(?:access|call|invoke|query)\b.{0,60}\b(?:other|another)\s+(?:MCP\s+)?(?:server|tool)\b/i,
    message: "Cross-server reference: may attempt lateral movement across MCP servers",
  },
];

/**
 * Parameter names that are suspicious when used as tool input parameter names.
 * Checked by EP-param in Wave 11.1b when live tool introspection is wired.
 */
export const SUSPICIOUS_PARAM_NAMES = new Set([
  "api_key",
  "apikey",
  "api_token",
  "apitoken",
  "access_key",
  "access_token",
  "secret",
  "secret_key",
  "secret_token",
  "password",
  "passwd",
  "token",
  "auth_token",
  "authorization",
  "private_key",
  "private_token",
  "bearer_token",
  "session_id",
  "session_token",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "ssn",
  "social_security",
  "credit_card",
  "card_number",
  "cvv",
  "pin",
  "encryption_key",
]);

/** Categories for which the PI leetspeak second-pass applies. */
export const LEETSPEAK_CATEGORIES: Set<McpFindingCategory> = new Set(["PI"]);
