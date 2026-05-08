import { describe, it, expect } from "vitest";
import { createDecisionParser } from "@/lib/tasks/decisionParser";

describe("createDecisionParser", () => {
  it("detects a bare DECISION marker", () => {
    const p = createDecisionParser();
    const events = p.feed("DECISION: Should I overwrite the file?");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "decision", prompt: "Should I overwrite the file?", choices: null });
  });

  it("parses choices from bracket notation", () => {
    const p = createDecisionParser();
    const events = p.feed("DECISION: Overwrite auth.ts? [yes, no, abort]");
    expect(events).toHaveLength(1);
    expect(events[0].choices).toEqual(["yes", "no", "abort"]);
    expect(events[0].prompt).toBe("Overwrite auth.ts?");
  });

  it("detects an INBOX marker", () => {
    const p = createDecisionParser();
    const events = p.feed("INBOX: Still building the migration");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "inbox", prompt: "Still building the migration", choices: null });
  });

  it("returns empty for normal output lines", () => {
    const p = createDecisionParser();
    expect(p.feed("const x = 1;")).toHaveLength(0);
    expect(p.feed("")).toHaveLength(0);
    expect(p.feed("  Doing some work")).toHaveLength(0);
  });

  it("ignores DECISION markers inside a fenced code block", () => {
    const p = createDecisionParser();
    p.feed("Here is an example:");
    p.feed("```");
    const insideFence = p.feed("DECISION: This is inside a fence [yes, no]");
    expect(insideFence).toHaveLength(0);
    p.feed("```");
    // After closing fence, markers work again
    const afterFence = p.feed("DECISION: Real decision?");
    expect(afterFence).toHaveLength(1);
  });

  it("ignores INBOX markers inside a fenced code block", () => {
    const p = createDecisionParser();
    p.feed("```sh");
    expect(p.feed("INBOX: This is inside a fence")).toHaveLength(0);
    p.feed("```");
    expect(p.feed("INBOX: Real message")).toHaveLength(1);
  });

  it("handles nested/consecutive fences correctly", () => {
    const p = createDecisionParser();
    p.feed("```");
    expect(p.feed("DECISION: inside [a, b]")).toHaveLength(0);
    p.feed("```");
    expect(p.feed("DECISION: outside [a, b]")).toHaveLength(1);
  });

  it("is case-insensitive for the keyword", () => {
    const p = createDecisionParser();
    expect(p.feed("decision: Lower case")).toHaveLength(1);
    expect(p.feed("INBOX: Upper case")).toHaveLength(1);
  });

  it("trims prompt and choices whitespace", () => {
    const p = createDecisionParser();
    const events = p.feed("  DECISION:   What to do?   [ yes ,  no  ]  ");
    expect(events).toHaveLength(1);
    expect(events[0].prompt).toBe("What to do?");
    expect(events[0].choices).toEqual(["yes", "no"]);
  });

  it("returns empty for malformed DECISION line (no prompt)", () => {
    const p = createDecisionParser();
    expect(p.feed("DECISION:")).toHaveLength(0);
    expect(p.feed("DECISION:  ")).toHaveLength(0);
  });

  it("finish() resets fence state", () => {
    const p = createDecisionParser();
    p.feed("```");
    // Inside fence — markers suppressed
    expect(p.feed("DECISION: Inside fence")).toHaveLength(0);
    p.finish();
    // finish() reset inFence, so next feed is outside
    expect(p.feed("DECISION: After finish")).toHaveLength(1);
  });

  it("INBOX and DECISION do not cross-match", () => {
    const p = createDecisionParser();
    expect(p.feed("INBOX: Some message [a, b]")[0].kind).toBe("inbox");
    expect(p.feed("DECISION: A question?")[0].kind).toBe("decision");
  });
});
