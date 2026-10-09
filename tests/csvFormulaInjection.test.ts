import { describe, it, expect } from "vitest";
import { escapeCell, toCsv } from "@/lib/csv";

// #641 — text that starts with = + - @ TAB or CR is evaluated as a formula when the CSV is opened in a
// spreadsheet, and SQL results carry repository/session/tool-controlled values.

describe("CSV formula injection (#641)", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\tcmd", "\rcmd", "\n=1+1",'=HYPERLINK("http://evil","x")'])(
    "defuses text %j with a leading apostrophe",
    (v) => {
      const out = escapeCell(v);
      const unquoted = out.startsWith('"') ? out.slice(1) : out;
      expect(unquoted.startsWith("'")).toBe(true);
    },
  );

  it("keeps the apostrophe inside the quoting when the cell also needs quotes", () => {
    expect(escapeCell('=HYPERLINK("a","b")')).toBe('"\'=HYPERLINK(""a"",""b"")"');
  });

  it("leaves real numbers and ordinary text alone", () => {
    expect(escapeCell(-5)).toBe("-5");
    expect(escapeCell(-0.25)).toBe("-0.25");
    expect(escapeCell(BigInt(-3))).toBe("-3");
    expect(escapeCell("plain - dash")).toBe("plain - dash");
    expect(escapeCell("a=b")).toBe("a=b");
  });

  it("applies to header cells and rows through toCsv", () => {
    expect(toCsv([{ "=x": "-2", n: -2 }], ["=x", "n"])).toBe("'=x,n\r\n'-2,-2");
  });
});
