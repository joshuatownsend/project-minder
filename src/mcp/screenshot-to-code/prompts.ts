// Prompt template + response cleanup for the screenshot-to-React tool.
//
// Kept in its own file so unit tests can exercise the cleanup without
// pulling in the MCP SDK or any provider HTTP code.

export type { Framework, Variant } from "./constants";
import type { Framework, Variant } from "./constants";

export interface PromptOptions {
  framework: Framework;
  variant: Variant;
}

export function buildPrompt(opts: PromptOptions): string {
  const styling =
    opts.framework === "react-tailwind"
      ? "Use Tailwind CSS utility classes for all styling. Do not import any external CSS."
      : "Use inline `style={{...}}` objects only. Do not import any external CSS.";
  const verbosity =
    opts.variant === "verbose"
      ? "Include helpful TypeScript types and prop-driven sections where the layout suggests reusable components."
      : "Use a single function component. Inline values, no prop drilling, no extra abstraction.";

  return [
    "You are a senior frontend engineer. Convert the attached screenshot into a single self-contained React TypeScript component.",
    "",
    "Requirements:",
    `- ${styling}`,
    `- ${verbosity}`,
    "- Export the component as the default export.",
    "- Match the layout, hierarchy, and approximate spacing of the screenshot. Approximate colors and font sizes; do not invent content that isn't visible.",
    "- Use semantic HTML where appropriate (header/nav/main/section/article/footer/button/etc.).",
    "- Do not include placeholder lorem ipsum unless the screenshot itself shows placeholder text.",
    "",
    "Output rules — strict:",
    "- Respond with code only. No prose before or after.",
    "- No markdown fences (no ```tsx, no ```).",
    "- Start with the import line; end with the default export line.",
  ].join("\n");
}

/** Strip the common ways providers wrap code despite the prompt:
 *   - leading/trailing markdown fences (```tsx … ``` or ``` … ```)
 *   - leading prose paragraphs before the first import / export / const
 *   - a single leading "Here is …:" sentence
 *
 * Returns the cleaned code body. Idempotent — calling twice is a no-op.
 */
export function cleanCodeBlock(raw: string): string {
  let s = raw.trim();

  // Pull the content out of the first fenced block. Non-greedy on the
  // body, no end-of-string anchor — this also handles "code in fence
  // followed by chatty prose" without dragging the prose along.
  const fenceMatch = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  } else if (s.startsWith("```")) {
    // Opening fence with no closing fence — strip the opening fence
    // and trim. (Closing fence is handled by the match above when present.)
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, "").trim();
  }

  // Trim any prose lines before the first code-looking line. "Code-looking"
  // means import/export/const/let/var/function/type/interface/class/// .
  const lines = s.split("\n");
  const firstCodeIdx = lines.findIndex((line) =>
    /^\s*(import|export|const|let|var|function|type|interface|class|\/\/|\/\*)/.test(line),
  );
  if (firstCodeIdx > 0) {
    s = lines.slice(firstCodeIdx).join("\n").trim();
  }

  return s;
}
