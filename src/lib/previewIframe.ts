// Builds the iframe HTML that renders LLM-generated TSX live.
//
// Why everything is inside the iframe (not the parent bundle):
//
//   @babel/standalone is ~3 MB and only needed for the playground preview.
//   Loading it into the parent bundle would bloat every Next route. Loading
//   it from a CDN inside an iframe with `sandbox="allow-scripts"` (and no
//   `allow-same-origin`) gives the parent zero bundle cost AND a proper
//   security boundary: the iframe runs in an opaque origin and cannot
//   touch the host's cookies, localStorage, or DOM.
//
// Why React 18 UMD and not React 19:
//
//   React 19 deliberately dropped UMD builds (ESM only). Using ESM forces
//   Babel to emit native modules + an importmap, which complicates the
//   in-iframe compile loop. React 18 UMD is the smallest path that works.
//   Visual fidelity is unchanged for utility-class previews — Tailwind
//   classes render identically.
//
// Why we strip imports rather than resolve modules:
//
//   `@babel/standalone` doesn't ship a module resolver — `import React
//   from "react"` throws at runtime. Stripping ES-module imports in a
//   regex pre-pass and exposing React + common hooks on `window` is the
//   cleanest workaround.

/** ES-module `import` statement matcher.
 *
 *  Handles:
 *   - single-line default / named / namespace imports
 *   - multi-line named imports (`import {\n  ...\n} from "x";`)
 *   - bare side-effect imports (`import "./styles.css";`)
 *
 *  Anchored to line-start with `^` under the `m` flag so string literals
 *  containing the word `import` in user code are left alone. The negative
 *  lookahead `(?!\s*\()` prevents matching dynamic `import("…")` calls,
 *  which superficially look the same to a regex but are runtime
 *  expressions, not module declarations. */
const IMPORT_RE =
  /^[ \t]*import\b(?!\s*\()[\s\S]*?["'][^"']*["'][ \t]*;?[ \t]*(?=\n|$)/gm;

/** Strip every ES-module `import` statement from a TSX/JSX/TS/JS source.
 *
 *  Leaves dynamic `import()` calls, the word `import` in string literals,
 *  and `export` statements alone. */
export function stripImports(code: string): string {
  return code.replace(IMPORT_RE, "").replace(/^\s*\n+/, "");
}

/** Rewrite `export default <expr>` into `window.__Default = <expr>` so the
 *  preview harness can pick it up.
 *
 *  Handles three forms observed in LLM output:
 *
 *    export default function NAME(...) { ... }
 *    export default function (...) { ... }
 *    export default <bareExpr>;
 *
 *  Anonymous functions become assignment expressions; named functions are
 *  kept as declarations followed by an assignment so the function name
 *  remains visible inside the component body (for self-recursion / display
 *  in React DevTools). */
export function rewriteDefaultExport(code: string): string {
  // Named function form. Capture the identifier so we can both keep the
  // declaration and assign by name afterwards.
  const namedFn = code.match(/^[ \t]*export\s+default\s+function\s+([A-Za-z_$][\w$]*)/m);
  if (namedFn) {
    const name = namedFn[1];
    return code.replace(
      /^[ \t]*export\s+default\s+function\s+([A-Za-z_$][\w$]*)/m,
      `function ${name}`,
    ) + `\n;window.__Default = ${name};`;
  }
  // Anonymous function form (function or arrow).
  if (/^[ \t]*export\s+default\s+function\s*\(/m.test(code)) {
    return code.replace(/^[ \t]*export\s+default\s+function/m, "window.__Default = function");
  }
  // Bare expression (e.g. `export default Foo;` or `export default () => …`).
  return code.replace(/^[ \t]*export\s+default\s+/m, "window.__Default = ");
}

/** Compose the iframe-ready preview source from raw LLM output.
 *
 *  Returns the code body Babel will compile. Caller is responsible for
 *  wrapping it in the harness HTML — keeping this step pure makes the
 *  transform unit-testable without spawning a browser. */
export function preparePreviewCode(rawCode: string): string {
  return rewriteDefaultExport(stripImports(rawCode));
}

const TAILWIND_BROWSER_URL = "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4";
const REACT_UMD_URL = "https://unpkg.com/react@18/umd/react.development.js";
const REACT_DOM_UMD_URL = "https://unpkg.com/react-dom@18/umd/react-dom.development.js";
const BABEL_STANDALONE_URL = "https://unpkg.com/@babel/standalone@7/babel.min.js";

/** Build the full `srcdoc` HTML string for the preview iframe.
 *
 *  The harness:
 *   1. Loads React/ReactDOM UMD + Babel standalone + Tailwind v4 from CDN.
 *   2. Wires an error reporter that posts compile + runtime errors back to
 *      the parent window via `postMessage`. Origin is "null" inside a
 *      sandboxed-without-same-origin iframe, so parent matches by source
 *      reference (not origin string).
 *   3. Compiles the user's TSX with `presets=typescript,react`.
 *   4. Mounts `window.__Default` into `#root` via `createRoot`.
 *
 *  All inline `</script>` sequences in user code are escaped so they don't
 *  prematurely close the `<script type="text/babel">` tag. */
export function buildPreviewSrcDoc(rawCode: string): string {
  const safe = preparePreviewCode(rawCode).replace(/<\/script>/gi, "<\\/script>");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Preview</title>
<script src="${TAILWIND_BROWSER_URL}"></script>
<script crossorigin src="${REACT_UMD_URL}"></script>
<script crossorigin src="${REACT_DOM_UMD_URL}"></script>
<script src="${BABEL_STANDALONE_URL}"></script>
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; }
  #root { min-height: 100vh; }
  #__preview_err {
    display: none;
    position: fixed; inset: 8px; padding: 12px 14px;
    background: #2a0000; color: #f87171;
    font: 12px/1.5 ui-monospace, monospace;
    border: 1px solid #b91c1c; border-radius: 6px;
    white-space: pre-wrap; overflow: auto;
    z-index: 9999;
  }
</style>
</head>
<body>
<div id="root"></div>
<pre id="__preview_err"></pre>
<script>
  // Surface compile + runtime errors both in-frame (for the user) and
  // out-of-frame (parent overlay). Parent listener matches by event.source,
  // not origin (sandbox = opaque origin = origin "null"). See preparePreviewCode.
  function __reportPreviewError(msg, stack) {
    try {
      var el = document.getElementById("__preview_err");
      if (el) { el.style.display = "block"; el.textContent = msg + (stack ? "\\n\\n" + stack : ""); }
      parent.postMessage({ kind: "preview-error", message: String(msg), stack: stack ? String(stack) : undefined }, "*");
    } catch (_) { /* parent already gone */ }
  }
  window.addEventListener("error", function (e) {
    __reportPreviewError(e.message || "Unknown error", e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason || {};
    __reportPreviewError(r.message || String(r), r.stack);
  });
</script>
<script type="text/babel" data-presets="typescript,react" data-type="module">
try {
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const {
    Fragment, StrictMode,
    useState, useEffect, useRef, useCallback, useMemo,
    useLayoutEffect, useReducer, useContext, useId,
    forwardRef, memo, lazy, Suspense, createContext, createElement,
  } = React;

${safe}

  if (typeof window.__Default !== "function") {
    throw new Error("No default export found. The generated code must end with 'export default …'.");
  }
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(React.createElement(window.__Default));
  parent.postMessage({ kind: "preview-ready" }, "*");
} catch (err) {
  __reportPreviewError(err && err.message ? err.message : String(err), err && err.stack);
}
</script>
</body>
</html>`;
}
