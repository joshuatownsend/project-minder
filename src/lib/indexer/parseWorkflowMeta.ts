/**
 * Static parser for a workflow script's `export const meta = { … }` block.
 *
 * **Never executes the script.** A workflow script is arbitrary JavaScript that
 * spawns subagents; running it to read its name would be absurd. The `meta`
 * object is a pure literal by contract — no variables, calls, spreads or
 * template interpolation — which is exactly the property that makes a
 * conservative static read safe.
 *
 * It is JavaScript, not frontmatter and not JSON: keys are usually bare
 * identifiers, strings may be single- or double-quoted, and trailing commas are
 * normal. So this cannot delegate to `JSON.parse`, and pulling in a full JS
 * parser for one object literal is not worth the dependency. It fails soft on
 * anything unexpected — a script whose meta cannot be read still appears in the
 * catalog under its filename, because a workflow that exists is more useful to
 * show than to hide behind a parse error.
 */

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
  /** Anything that stopped the parse, for the catalog's lint chip. */
  warnings: string[];
}

/**
 * Find the balanced `{…}` that follows `export const meta =`.
 *
 * Brace counting has to ignore braces inside strings and comments, or the first
 * `}` in a description like `"use {this}"` truncates the object. Returns the
 * literal's source text, or null when there is no meta block to read.
 */
function extractMetaSource(text: string): string | null {
  const decl = /export\s+const\s+meta\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=\s*\{/.exec(text);
  if (!decl) return null;

  const start = decl.index + decl[0].length - 1; // position of the opening brace
  let depth = 0;
  let i = start;
  let quote: string | null = null;
  let escaped = false;

  while (i < text.length) {
    const ch = text[i];

    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      i++;
      continue;
    }

    // Comments only matter outside strings; a `//` inside a URL string must not
    // start one, which the branch above already guarantees.
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

/**
 * Read a string literal starting at `pos` (which must be its opening quote).
 * Returns the decoded value and the index just past the closing quote.
 *
 * Handles the escapes that actually occur in these files — `\"`, `\'`, `\\`,
 * `\n`, `\t` — and passes anything else through as the literal character, which
 * is what a reader that must not throw should do with an escape it doesn't know.
 */
function readString(src: string, pos: number): { value: string; next: number } | null {
  const quote = src[pos];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let out = "";
  let i = pos + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const nxt = src[i + 1];
      if (nxt === "n") out += "\n";
      else if (nxt === "t") out += "\t";
      else if (nxt === "r") out += "\r";
      else out += nxt ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, next: i + 1 };
    out += ch;
    i++;
  }
  return null; // unterminated
}

/**
 * Value of a top-level `key:` in the meta literal, as source text.
 *
 * "Top-level" is load-bearing: `phases` contains objects with their own
 * `title`/`detail` keys, and a naive regex for `title:` would find one of those
 * when asked for the outer object's. Depth is tracked so only depth-1 keys match.
 */
function findTopLevelValue(metaSrc: string, key: string): { start: number } | null {
  let depth = 0;
  let i = 0;
  let quote: string | null = null;
  let escaped = false;

  while (i < metaSrc.length) {
    const ch = metaSrc[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      i++;
      continue;
    }

    // Comments are skipped before anything else looks at the character.
    //
    // A commented-out field is ordinary in a script someone edited — `// name:
    // "old"` above the live `name` — and without this the scan matched the
    // stale key first and catalogued the workflow under a name its author had
    // deliberately retired, merging it with whatever else shared that identity.
    // Braces inside a comment were worse than a wrong name: they corrupted the
    // tracked depth, so every later top-level key silently stopped matching
    // (Codex review, #389).
    if (ch === "/" && metaSrc[i + 1] === "/") {
      const nl = metaSrc.indexOf("\n", i);
      i = nl === -1 ? metaSrc.length : nl + 1;
      continue;
    }
    if (ch === "/" && metaSrc[i + 1] === "*") {
      const end = metaSrc.indexOf("*/", i + 2);
      i = end === -1 ? metaSrc.length : end + 2;
      continue;
    }

    // The key test runs BEFORE the quote-opening branch on purpose. A
    // JSON-style key is itself quoted (`{"title":"Scope"}`), so opening the
    // string first consumes the key as a value and the match never fires —
    // which silently dropped every `phases` array, since the Workflow tool
    // serialises them with quoted keys.
    if (depth === 1) {
      const rest = metaSrc.slice(i);
      const m = new RegExp(`^["']?${key}["']?\\s*:`).exec(rest);
      if (m && (i === 0 || /[\s,{[]/.test(metaSrc[i - 1]))) {
        return { start: i + m[0].length };
      }
    }

    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; i++; continue; }
    if (ch === "{" || ch === "[") { depth++; i++; continue; }
    if (ch === "}" || ch === "]") { depth--; i++; continue; }
    i++;
  }
  return null;
}

function readStringKey(metaSrc: string, key: string): string | undefined {
  const found = findTopLevelValue(metaSrc, key);
  if (!found) return undefined;
  let i = found.start;
  while (i < metaSrc.length && /\s/.test(metaSrc[i])) i++;
  const str = readString(metaSrc, i);
  return str ? str.value : undefined;
}

/** Parse `phases: [ {title, detail}, … ]`, tolerating either key being absent. */
function readPhases(metaSrc: string): { phases?: WorkflowPhase[]; warning?: string } {
  const found = findTopLevelValue(metaSrc, "phases");
  if (!found) return {};
  let i = found.start;
  while (i < metaSrc.length && /\s/.test(metaSrc[i])) i++;
  if (metaSrc[i] !== "[") return { warning: "phases is not an array literal" };

  const phases: WorkflowPhase[] = [];
  let depth = 0;
  let objStart = -1;
  let quote: string | null = null;
  let escaped = false;

  for (; i < metaSrc.length; i++) {
    const ch = metaSrc[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    // Same comment skip as `findTopLevelValue`. A `{` or `[` inside a comment
    // here would unbalance `depth` and either swallow the rest of the array or
    // end it early, so the phase list would come back short with no warning.
    // Indices are set one short because the `for` header's `i++` runs on
    // `continue`.
    if (ch === "/" && metaSrc[i + 1] === "/") {
      const nl = metaSrc.indexOf("\n", i);
      i = nl === -1 ? metaSrc.length : nl;
      continue;
    }
    if (ch === "/" && metaSrc[i + 1] === "*") {
      const end = metaSrc.indexOf("*/", i + 2);
      i = (end === -1 ? metaSrc.length : end + 2) - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "[") { depth++; continue; }
    if (ch === "]") { depth--; if (depth === 0) break; continue; }
    if (ch === "{" && depth === 1) { objStart = i; depth++; continue; }
    if (ch === "{") { depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 1 && objStart >= 0) {
        const objSrc = metaSrc.slice(objStart, i + 1);
        const title = readStringKey(objSrc, "title");
        const detail = readStringKey(objSrc, "detail");
        if (title) phases.push({ title, ...(detail ? { detail } : {}) });
        objStart = -1;
      }
      continue;
    }
  }
  return phases.length > 0 ? { phases } : {};
}

/**
 * Parse a workflow script's meta block.
 *
 * Always returns an object. `warnings` carries what could not be read; callers
 * surface it rather than dropping the workflow, matching how the skills catalog
 * treats a bad frontmatter block.
 */
export function parseWorkflowMeta(text: string): WorkflowMeta {
  const warnings: string[] = [];
  const metaSrc = extractMetaSource(text);
  if (!metaSrc) {
    return { warnings: ["No `export const meta = { … }` block found"] };
  }

  const name = readStringKey(metaSrc, "name");
  const description = readStringKey(metaSrc, "description");
  const whenToUse = readStringKey(metaSrc, "whenToUse");
  const { phases, warning } = readPhases(metaSrc);
  if (warning) warnings.push(warning);
  // `name` and `description` are required by the Workflow tool's contract, so
  // their absence is a real signal about the script, not a parser limitation.
  if (!name) warnings.push("meta.name missing or not a string literal");
  if (!description) warnings.push("meta.description missing or not a string literal");

  return { name, description, whenToUse, phases, warnings };
}
