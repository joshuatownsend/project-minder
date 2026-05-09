/**
 * 8-pass deobfuscation pipeline for MCP security scanning.
 *
 * Each pass is exported individually so tests can exercise them in isolation.
 * The composite `deobfuscate()` function runs all passes in order; an optional
 * second PI pass applies leetspeak normalization for prompt-injection rules.
 *
 * Inspired by the mcpware/cross-code-organizer MIT-licensed reference
 * (src/security-scanner.mjs). Pattern counts and pass names match that
 * reference to keep future diffs minimal.
 */

/** Remove Unicode zero-width characters used to hide instructions. */
export function stripZeroWidth(s: string): string {
  // U+200B ZERO WIDTH SPACE, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM/ZWNBSP
  return s.replace(/[​‌‍﻿]/g, "");
}

/** Strip Unicode tag characters (U+E0000-U+E007F) used in homoglyph attacks. */
export function stripTagChars(s: string): string {
  // These are above the BMP; in UTF-16 they appear as surrogate pairs:
  // high surrogate U+DB40, low surrogate U+DC00-U+DC7F.
  return s.replace(/\uDB40[\uDC00-\uDC7F]/g, "");
}

/** Strip Unicode variation selectors (U+FE00-U+FE0F, U+E0100-U+E01EF). */
export function stripVariationSelectors(s: string): string {
  return s.replace(/[︀-️]|\uDB40[\uDD00-\uDDEF]/g, "");
}

/** Strip Unicode bidirectional control characters used for text-direction spoofing. */
export function stripBidiControls(s: string): string {
  // LRM U+200E, RLM U+200F, LRE U+202A, RLE U+202B, PDF U+202C,
  // LRO U+202D, RLO U+202E, LRI U+2066, RLI U+2067, FSI U+2068, PDI U+2069
  return s.replace(/[‎‏‪-‮⁦-⁩]/g, "");
}

/** Strip HTML/XML comment blocks that could embed instructions. */
export function stripHtmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

/** NFKC normalization collapses look-alike Unicode characters to ASCII equivalents. */
export function normalizeUnicode(s: string): string {
  return s.normalize("NFKC");
}

const BASE64_RE = /(?:[A-Za-z0-9+/]{4}){3,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;

/**
 * Decode base64 chunks and splice the decoded text back into the string.
 * Only replaces chunks that decode to printable ASCII so we don't mangle
 * legitimate base64 binary payloads like images.
 */
export function decodeBase64Blocks(s: string): string {
  return s.replace(BASE64_RE, (match) => {
    try {
      const decoded = Buffer.from(match, "base64").toString("utf8");
      // Only substitute if the decoded text is printable (no control chars).
      if (/^[\x20-\x7E\t\n\r]+$/.test(decoded)) return decoded;
    } catch {
      // invalid base64 — leave as-is
    }
    return match;
  });
}

/** Unescape common escape sequences: \x??, \u????, URL-encoded %XX. */
export function unescapeSequences(s: string): string {
  return s
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Normalise leetspeak substitutions commonly used to bypass simple regex
 * rules in prompt-injection text: 0->o, 1->i/l, 3->e, 4->a, @->a, $->s, !->i.
 * Applied only as a second pass in PI rule scanning, not in the main pipeline,
 * so the raw text is still preserved for display.
 */
export function normalizeLeetspeak(s: string): string {
  return s
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/!/g, "i");
}

/**
 * Run all 8 passes in order. The result is suitable for pattern matching.
 * Pass `leetspeak: true` to apply the extra normalization pass (used by
 * PI rules to catch obfuscated prompt-injection strings).
 */
export function deobfuscate(s: string, leetspeak = false): string {
  let r = stripZeroWidth(s);
  r = stripTagChars(r);
  r = stripVariationSelectors(r);
  r = stripBidiControls(r);
  r = stripHtmlComments(r);
  r = normalizeUnicode(r);
  r = decodeBase64Blocks(r);
  r = unescapeSequences(r);
  if (leetspeak) r = normalizeLeetspeak(r);
  return r;
}
