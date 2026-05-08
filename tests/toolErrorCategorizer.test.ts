import { describe, it, expect } from "vitest";
import { categorizeToolError } from "@/lib/usage/toolErrorCategorizer";

describe("categorizeToolError", () => {
  it("classifies EACCES as permission", () => {
    expect(categorizeToolError("Error: EACCES: permission denied, open '/etc/hosts'")).toBe("permission");
  });

  it("classifies 'access denied' as permission", () => {
    expect(categorizeToolError("Access denied: cannot write to protected path")).toBe("permission");
  });

  it("classifies ETIMEDOUT as timeout", () => {
    expect(categorizeToolError("ETIMEDOUT: connection timed out after 5000ms")).toBe("timeout");
  });

  it("classifies 'took too long' as timeout", () => {
    expect(categorizeToolError("Command took too long to complete")).toBe("timeout");
  });

  it("classifies ENOENT as not-found", () => {
    expect(categorizeToolError("Error: ENOENT: no such file or directory, open 'missing.ts'")).toBe("not-found");
  });

  it("classifies 'file not found' as not-found", () => {
    expect(categorizeToolError("file not found: config.json")).toBe("not-found");
  });

  it("classifies 'syntax error' as parse", () => {
    expect(categorizeToolError("SyntaxError: Unexpected token '}' at line 42")).toBe("parse");
  });

  it("classifies ECONNREFUSED as network", () => {
    expect(categorizeToolError("Error: ECONNREFUSED 127.0.0.1:3000")).toBe("network");
  });

  it("classifies 'socket hang up' as network", () => {
    expect(categorizeToolError("socket hang up")).toBe("network");
  });

  it("classifies 'interrupted' as interrupted", () => {
    expect(categorizeToolError("Process interrupted by user")).toBe("interrupted");
  });

  it("classifies 'aborted' as interrupted", () => {
    expect(categorizeToolError("Operation aborted")).toBe("interrupted");
  });

  it("classifies unknown errors as other", () => {
    expect(categorizeToolError("Something went wrong")).toBe("other");
    expect(categorizeToolError("")).toBe("other");
  });

  it("first matching rule wins (permission before not-found when both match)", () => {
    // This string matches permission first in rule order.
    expect(categorizeToolError("permission denied: file not found")).toBe("permission");
  });
});
