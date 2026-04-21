/**
 * Minimal dependency-free markdown renderer.
 * Handles fenced code blocks (``` ... ```) and inline `code` spans.
 * Returns an array of React-compatible descriptor objects that the
 * caller renders — keeps this module framework-agnostic and testable.
 */

export type MarkdownSegment =
  | { kind: "text"; content: string }
  | { kind: "code_block"; lang: string; content: string }
  | { kind: "code_inline"; content: string };

/**
 * Parse a string into typed segments.
 * Fenced blocks take priority; inline code is processed within text segments.
 */
export function parseMarkdown(input: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  // Split on triple-backtick fences.
  const fenceParts = input.split(/```/);

  for (let i = 0; i < fenceParts.length; i++) {
    if (i % 2 === 1) {
      // Inside a fence: first line is the language hint (may be empty).
      const newlineIdx = fenceParts[i].indexOf("\n");
      const lang = newlineIdx === -1 ? "" : fenceParts[i].slice(0, newlineIdx).trim();
      const content = newlineIdx === -1 ? fenceParts[i] : fenceParts[i].slice(newlineIdx + 1);
      segments.push({ kind: "code_block", lang, content });
    } else if (fenceParts[i]) {
      // Outside a fence: split on inline backtick spans.
      parseInlineCode(fenceParts[i], segments);
    }
  }
  return segments;
}

function parseInlineCode(text: string, out: MarkdownSegment[]): void {
  const parts = text.split(/`([^`]+)`/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out.push({ kind: "code_inline", content: parts[i] });
    } else if (parts[i]) {
      out.push({ kind: "text", content: parts[i] });
    }
  }
}

/** Returns true when the string contains a fenced code block. */
export function hasCodeFence(input: string): boolean {
  return input.includes("```");
}
