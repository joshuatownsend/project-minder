import { describe, it, expect } from "vitest";
import { modelFamily, shortModelName } from "@/lib/usage/modelHelpers";

describe("modelFamily", () => {
  it("identifies opus", () => {
    expect(modelFamily("claude-opus-4-7")).toBe("opus");
    expect(modelFamily("claude-opus-4-7-20250514")).toBe("opus");
  });

  it("identifies sonnet", () => {
    expect(modelFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(modelFamily("claude-sonnet-3-5-20241022")).toBe("sonnet");
  });

  it("identifies haiku", () => {
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("falls back to other for unknown", () => {
    expect(modelFamily("gpt-4o")).toBe("other");
    expect(modelFamily("")).toBe("other");
    expect(modelFamily(null)).toBe("other");
    expect(modelFamily(undefined)).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(modelFamily("Claude-Opus-4-7")).toBe("opus");
    expect(modelFamily("SONNET")).toBe("sonnet");
  });
});

describe("shortModelName", () => {
  it("strips claude- prefix", () => {
    expect(shortModelName("claude-sonnet-4-6")).toBe("sonnet-4-6");
  });

  it("strips trailing YYYYMMDD build tag", () => {
    expect(shortModelName("claude-opus-4-7-20250514")).toBe("opus-4-7");
  });

  it("strips both prefix and build tag", () => {
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  it("handles models without the prefix", () => {
    expect(shortModelName("gpt-4o")).toBe("gpt-4o");
  });

  it("returns unknown for falsy input", () => {
    expect(shortModelName(null)).toBe("unknown");
    expect(shortModelName(undefined)).toBe("unknown");
    expect(shortModelName("")).toBe("unknown");
  });
});
