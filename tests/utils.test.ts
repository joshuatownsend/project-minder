import { describe, it, expect } from "vitest";
import { formatKB, pluralize } from "@/lib/utils";

describe("formatKB", () => {
  it("formats 0 bytes", () => {
    expect(formatKB(0)).toBe("0.0 KB");
  });

  it("formats sub-1 KB values to one decimal", () => {
    expect(formatKB(512)).toBe("0.5 KB");
  });

  it("formats round KB values", () => {
    expect(formatKB(40 * 1024)).toBe("40.0 KB");
    expect(formatKB(80 * 1024)).toBe("80.0 KB");
  });

  it("rounds non-integer KB to one decimal", () => {
    expect(formatKB(1500)).toBe("1.5 KB");
    expect(formatKB(1024 + 256)).toBe("1.3 KB");
  });

  it("handles large values without scientific notation", () => {
    expect(formatKB(1024 * 1024)).toBe("1024.0 KB");
  });
});

describe("pluralize", () => {
  it("singular form for 1", () => {
    expect(pluralize(1, "file")).toBe("1 file");
  });

  it("plural form for 0 and >1", () => {
    expect(pluralize(0, "file")).toBe("0 files");
    expect(pluralize(2, "file")).toBe("2 files");
    expect(pluralize(99, "rule")).toBe("99 rules");
  });
});
