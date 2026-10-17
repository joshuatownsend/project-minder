import { describe, it, expect } from "vitest";
import type { SessionSummary } from "@/lib/types";
import { forSessionsList, LIST_PROMPT_CHARS } from "@/lib/data/sessionsListPayload";

// What the session list sends out of the server (#700, #704).

const session = (id: string, over: Partial<SessionSummary> = {}) =>
  ({ sessionId: id, ...over }) as SessionSummary;

describe("forSessionsList", () => {
  it("drops searchableText and leaves the caller's objects alone", () => {
    const s = session("x", { searchableText: "secret text" });
    const [out] = forSessionsList([s]);
    expect("searchableText" in out).toBe(false);
    expect(out.sessionId).toBe("x");
    expect(s.searchableText).toBe("secret text");
  });

  it("clips long prompts and marks the cut (#704)", () => {
    const head = "a".repeat(LIST_PROMPT_CHARS);
    const long = `${head}tail`;
    const s = session("x", { initialPrompt: long, lastPrompt: `b${long}` });
    const [out, short] = forSessionsList([s, session("y", { initialPrompt: head })]);
    expect(out.initialPrompt).toBe(`${head}…`);
    expect(out.lastPrompt).toBe(`b${head.slice(1)}…`);
    expect(s.initialPrompt).toBe(long);
    expect(short.initialPrompt).toBe(head);
    expect("lastPrompt" in short).toBe(false);
  });
});
