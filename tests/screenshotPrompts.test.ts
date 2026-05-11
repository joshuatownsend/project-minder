import { describe, it, expect } from "vitest";
import { buildPrompt, cleanCodeBlock } from "@/mcp/screenshot-to-code/prompts";

// `buildPrompt` is just a string template, so the tests focus on the
// branch behavior (framework / variant) rather than asserting full text.
// `cleanCodeBlock` is the workhorse — provider responses are messy in the
// real world, so the tests pin the cleanup against every regression we've
// seen in the wild.

describe("buildPrompt", () => {
  it("specifies tailwind for react-tailwind framework", () => {
    const p = buildPrompt({ framework: "react-tailwind", variant: "minimal" });
    expect(p).toMatch(/Tailwind CSS/i);
    expect(p).not.toMatch(/inline `style=/);
  });

  it("specifies inline styles for plain react framework", () => {
    const p = buildPrompt({ framework: "react", variant: "minimal" });
    expect(p).toMatch(/inline `style=/);
    expect(p).not.toMatch(/Tailwind/i);
  });

  it("verbose variant mentions sub-components", () => {
    const p = buildPrompt({ framework: "react-tailwind", variant: "verbose" });
    expect(p).toMatch(/sub-components|reusable components/i);
  });

  it("minimal variant mentions single function component", () => {
    const p = buildPrompt({ framework: "react-tailwind", variant: "minimal" });
    expect(p).toMatch(/single function component/i);
  });

  it("always includes the 'code only' guard", () => {
    const p = buildPrompt({ framework: "react", variant: "minimal" });
    expect(p).toMatch(/Respond with code only/);
    expect(p).toMatch(/no markdown fences/i);
  });
});

describe("cleanCodeBlock", () => {
  it("returns plain code unchanged", () => {
    const code = "import React from 'react';\nexport default function App() { return <div />; }";
    expect(cleanCodeBlock(code)).toBe(code);
  });

  it("strips ```tsx … ``` fences when the whole response is wrapped", () => {
    const wrapped = "```tsx\nimport React from 'react';\nexport default function App() { return null; }\n```";
    const out = cleanCodeBlock(wrapped);
    expect(out.startsWith("import")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
    expect(out).not.toContain("```");
  });

  it("strips ``` (no language tag) fences", () => {
    const wrapped = "```\nconst x = 1;\nexport default x;\n```";
    expect(cleanCodeBlock(wrapped)).toBe("const x = 1;\nexport default x;");
  });

  it("trims a 'Here is the component:' preamble", () => {
    const messy =
      "Here is the React component for the screenshot:\n\nimport React from 'react';\n\nexport default function App() {\n  return null;\n}";
    const out = cleanCodeBlock(messy);
    expect(out.startsWith("import React")).toBe(true);
    expect(out).not.toMatch(/Here is/);
  });

  it("strips opening fence even when closing fence is absent", () => {
    const partial = "```tsx\nimport React from 'react';\nexport default function App() { return null; }";
    const out = cleanCodeBlock(partial);
    expect(out.startsWith("import")).toBe(true);
    expect(out).not.toContain("```");
  });

  it("is idempotent", () => {
    const wrapped = "```tsx\nconst y = 2;\nexport default y;\n```";
    expect(cleanCodeBlock(cleanCodeBlock(wrapped))).toBe(cleanCodeBlock(wrapped));
  });

  it("preserves indentation inside the code body", () => {
    const wrapped =
      "```tsx\nexport default function X() {\n  if (true) {\n    return <div />;\n  }\n}\n```";
    const out = cleanCodeBlock(wrapped);
    expect(out).toContain("  if (true) {");
    expect(out).toContain("    return <div />;");
  });

  it("keeps only the first fenced block when the response has stray prose after", () => {
    const messy = "```tsx\nconst a = 1;\nexport default a;\n```\n\nLet me know if you want…";
    const out = cleanCodeBlock(messy);
    expect(out).toBe("const a = 1;\nexport default a;");
  });
});
