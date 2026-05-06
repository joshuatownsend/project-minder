import { describe, it, expect } from "vitest";
import { escapeCell, toCsv } from "@/lib/csv";

describe("escapeCell", () => {
  it("returns plain string as-is", () => {
    expect(escapeCell("hello")).toBe("hello");
  });

  it("quotes a cell containing a comma", () => {
    expect(escapeCell("a,b")).toBe('"a,b"');
  });

  it("quotes a cell containing a double quote and escapes it", () => {
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a cell containing a newline", () => {
    expect(escapeCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("quotes a cell containing a carriage return", () => {
    expect(escapeCell("line1\rline2")).toBe('"line1\rline2"');
  });

  it("converts null to empty string", () => {
    expect(escapeCell(null)).toBe("");
  });

  it("converts undefined to empty string", () => {
    expect(escapeCell(undefined)).toBe("");
  });

  it("converts numbers to string", () => {
    expect(escapeCell(42)).toBe("42");
    expect(escapeCell(3.14)).toBe("3.14");
  });

  it("converts 0 to string without quoting", () => {
    expect(escapeCell(0)).toBe("0");
  });

  it("handles a cell that is just a double quote", () => {
    expect(escapeCell('"')).toBe('""""');
  });

  it("handles a cell with comma AND double quote", () => {
    expect(escapeCell('a,"b"')).toBe('"a,""b"""');
  });
});

describe("toCsv", () => {
  it("produces a header row and data rows separated by CRLF", () => {
    const rows = [{ name: "Alice", age: 30 }];
    const result = toCsv(rows, ["name", "age"]);
    expect(result).toBe("name,age\r\nAlice,30");
  });

  it("handles multiple rows", () => {
    const rows = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const result = toCsv(rows, ["x", "y"]);
    expect(result).toBe("x,y\r\n1,2\r\n3,4");
  });

  it("produces only a header row for empty rows array", () => {
    const result = toCsv([], ["a", "b"]);
    expect(result).toBe("a,b");
  });

  it("escapes values with commas", () => {
    const rows = [{ val: "hello, world" }];
    const result = toCsv(rows, ["val"]);
    expect(result).toBe('val\r\n"hello, world"');
  });

  it("handles null values as empty strings", () => {
    const rows = [{ a: null, b: "ok" }];
    const result = toCsv(rows, ["a", "b"]);
    expect(result).toBe("a,b\r\n,ok");
  });

  it("columns order determines output order regardless of row key order", () => {
    const rows = [{ b: 2, a: 1 }];
    const result = toCsv(rows as Record<string, unknown>[], ["a", "b"]);
    expect(result).toBe("a,b\r\n1,2");
  });

  it("uses empty string for missing columns", () => {
    const rows = [{ a: 1 }];
    const result = toCsv(rows as Record<string, unknown>[], ["a", "b"]);
    expect(result).toBe("a,b\r\n1,");
  });
});
