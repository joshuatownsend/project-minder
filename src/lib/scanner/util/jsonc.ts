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
 * Also removes structural trailing commas before `}` / `]`. Commas appearing
 * inside string literals (e.g. `",}"`) are never touched.
 */
export function stripJsonComments(raw: string): string {
  const buf: string[] = [];
  let i = 0;
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  let inBlockComment = false;
  // Index in `buf` of the most recently emitted structural comma — i.e. a
  // comma that was outside any string/comment. -1 when no such comma is
  // pending. Used to retroactively drop the comma if the next non-whitespace
  // structural token turns out to be `}` or `]`.
  let pendingCommaIdx = -1;

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        buf.push(ch);
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
        buf.push(ch, next);
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      buf.push(ch);
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      pendingCommaIdx = -1;
      buf.push(ch);
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

    if (ch === ",") {
      pendingCommaIdx = buf.length;
      buf.push(ch);
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      if (pendingCommaIdx !== -1) {
        buf[pendingCommaIdx] = "";
        pendingCommaIdx = -1;
      }
      buf.push(ch);
      i++;
      continue;
    }

    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      pendingCommaIdx = -1;
    }

    buf.push(ch);
    i++;
  }

  return buf.join("");
}
