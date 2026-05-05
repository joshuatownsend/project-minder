import { describe, it, expect } from "vitest";
import { isBuggyVersion, BUGGY_VERSION_RANGE } from "@/lib/usage/versionDetector";

describe("isBuggyVersion", () => {
  it("exports the expected range constants", () => {
    expect(BUGGY_VERSION_RANGE.start).toBe("2.1.69");
    expect(BUGGY_VERSION_RANGE.end).toBe("2.1.89");
  });

  it("returns false for undefined", () => {
    expect(isBuggyVersion(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isBuggyVersion("")).toBe(false);
  });

  it("returns false for non-semver strings", () => {
    expect(isBuggyVersion("not-a-version")).toBe(false);
  });

  it("returns false for version just before range start (2.1.68)", () => {
    expect(isBuggyVersion("2.1.68")).toBe(false);
  });

  it("returns true for range start (2.1.69)", () => {
    expect(isBuggyVersion("2.1.69")).toBe(true);
  });

  it("returns true for mid-range version (2.1.75)", () => {
    expect(isBuggyVersion("2.1.75")).toBe(true);
  });

  it("returns true for range end (2.1.89)", () => {
    expect(isBuggyVersion("2.1.89")).toBe(true);
  });

  it("returns false for version just after range end (2.1.90)", () => {
    expect(isBuggyVersion("2.1.90")).toBe(false);
  });

  it("returns false for a much newer version (2.2.0)", () => {
    expect(isBuggyVersion("2.2.0")).toBe(false);
  });

  it("returns false for older major version (1.9.99)", () => {
    expect(isBuggyVersion("1.9.99")).toBe(false);
  });

  it("handles two-part versions (2.1 treated as 2.1.0 — before 2.1.69)", () => {
    expect(isBuggyVersion("2.1")).toBe(false);
  });
});
