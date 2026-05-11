import { describe, expect, it } from "vitest";
import {
  buildPreviewSrcDoc,
  preparePreviewCode,
  rewriteDefaultExport,
  stripImports,
} from "@/lib/previewIframe";

describe("stripImports", () => {
  it("removes a single-line default import", () => {
    const src = `import React from "react";\nconst x = 1;`;
    expect(stripImports(src)).toBe("const x = 1;");
  });

  it("removes a single-line named import without semicolon", () => {
    const src = `import { useState } from "react"\nconst x = 1;`;
    expect(stripImports(src)).toBe("const x = 1;");
  });

  it("removes a namespace import", () => {
    const src = `import * as React from "react";\nconst x = 1;`;
    expect(stripImports(src)).toBe("const x = 1;");
  });

  it("removes a bare side-effect import", () => {
    const src = `import "./styles.css";\nconst x = 1;`;
    expect(stripImports(src)).toBe("const x = 1;");
  });

  it("removes a multi-line named import", () => {
    const src = `import {\n  useState,\n  useEffect,\n} from "react";\nconst x = 1;`;
    expect(stripImports(src)).toBe("const x = 1;");
  });

  it("leaves the word 'import' inside a string literal alone", () => {
    const src = `const message = "please import the file";\nconst x = 1;`;
    expect(stripImports(src)).toBe(src);
  });

  it("leaves dynamic import() calls alone", () => {
    const src = `const m = await import("./thing");`;
    expect(stripImports(src)).toBe(src);
  });
});

describe("rewriteDefaultExport", () => {
  it("rewrites a named function default export", () => {
    const src = `export default function MyComponent() { return null; }`;
    const out = rewriteDefaultExport(src);
    expect(out).toContain("function MyComponent()");
    expect(out).toContain("window.__Default = MyComponent;");
    expect(out).not.toContain("export default");
  });

  it("rewrites an anonymous function default export", () => {
    const src = `export default function () { return null; }`;
    const out = rewriteDefaultExport(src);
    expect(out).toContain("window.__Default = function");
    expect(out).not.toContain("export default");
  });

  it("rewrites a bare-expression default export", () => {
    const src = `function Foo() {}\nexport default Foo;`;
    const out = rewriteDefaultExport(src);
    expect(out).toContain("window.__Default = Foo;");
    expect(out).not.toMatch(/export\s+default/);
  });

  it("rewrites an arrow-function default export", () => {
    const src = `export default () => null;`;
    const out = rewriteDefaultExport(src);
    expect(out).toContain("window.__Default = () => null;");
    expect(out).not.toMatch(/export\s+default/);
  });
});

describe("preparePreviewCode", () => {
  it("strips imports and rewrites the default export in one pass", () => {
    const src = [
      `import React from "react";`,
      `import { useState } from "react";`,
      ``,
      `export default function Card() {`,
      `  const [n, setN] = useState(0);`,
      `  return <div className="p-4">Hello {n}</div>;`,
      `}`,
    ].join("\n");
    const out = preparePreviewCode(src);
    expect(out).not.toMatch(/^import/m);
    expect(out).not.toMatch(/export\s+default/);
    expect(out).toContain("function Card()");
    expect(out).toContain("window.__Default = Card;");
  });

  it("is a no-op on already-prepared code (idempotent stripping)", () => {
    const src = `function Foo() { return null; } window.__Default = Foo;`;
    expect(preparePreviewCode(src)).toBe(src);
  });
});

describe("buildPreviewSrcDoc", () => {
  it("produces a full HTML document with the prepared code embedded", () => {
    const src = `import React from "react";\nexport default function X() { return null; }`;
    const doc = buildPreviewSrcDoc(src);
    expect(doc).toMatch(/^<!doctype html>/i);
    expect(doc).toContain('<div id="root"></div>');
    expect(doc).toContain("function X()");
    expect(doc).toContain("window.__Default = X;");
    expect(doc).not.toMatch(/^import\b/m);
  });

  it("references the Tailwind v4 browser CDN (not v3)", () => {
    const doc = buildPreviewSrcDoc(`export default () => null;`);
    expect(doc).toContain("@tailwindcss/browser@4");
    expect(doc).not.toContain("cdn.tailwindcss.com");
  });

  it("references the React 18 UMD bundle (React 19 has no UMD)", () => {
    const doc = buildPreviewSrcDoc(`export default () => null;`);
    expect(doc).toContain("react@18");
    expect(doc).toContain("react-dom@18");
  });

  it("includes the Babel standalone bundle and a babel-typed script tag", () => {
    const doc = buildPreviewSrcDoc(`export default () => null;`);
    expect(doc).toContain("@babel/standalone");
    expect(doc).toMatch(/<script type="text\/babel"[^>]*data-presets="typescript,react"/);
  });

  it("escapes inline </script> sequences in user code so the harness tag does not close early", () => {
    const src = `export default function X() { return <pre>{'</script>'}</pre>; }`;
    const doc = buildPreviewSrcDoc(src);
    // The literal string from user code is escaped; the only "</script>" tokens
    // that survive are the harness's own closing tags.
    const userCodeClosers = doc.match(/<\/script>/g) ?? [];
    // The HTML has 4 legitimate </script> tags (tailwind, react, react-dom, babel,
    // the error reporter, and the babel-typed user script) — exactly 6. The
    // important assertion is that the user-code literal does NOT add an extra one.
    expect(userCodeClosers.length).toBe(6);
    expect(doc).toContain("<\\/script>");
  });

  it("posts a 'preview-error' message kind to the parent on throw", () => {
    const doc = buildPreviewSrcDoc(`export default () => null;`);
    expect(doc).toContain('kind: "preview-error"');
    expect(doc).toContain('kind: "preview-ready"');
  });
});
