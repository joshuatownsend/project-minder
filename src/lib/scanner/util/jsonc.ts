/**
 * Parse JSON, tolerating `// line` and `/* block *\/` comments and trailing commas.
 *
 * Vercel and some `.mcp.json` files allow comments. We avoid pulling in an
 * external JSONC parser by trying strict `JSON.parse` first and stripping
 * comments only on failure.
 */
export function tryParseJsonc<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      return JSON.parse(stripJsonComments(raw)) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Strip `//` line comments and `/* *\/` block comments from a JSON string,
 * preserving the position of each character inside string literals so that
 * `//` or `/*` inside a quoted value is not mistaken for a comment.
 *
 * Also removes a single trailing comma before `}` / `]`.
 */
export function stripJsonComments(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  let inBlockComment = false;

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      if (ch === "\\" && i + 1 < raw.length) {
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      out += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
}
