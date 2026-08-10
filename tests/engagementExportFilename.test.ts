import { describe, it, expect } from "vitest";
import { __testing } from "@/app/api/engagement/export/route";

const { safeFilename, trimDashes } = __testing;

describe("safeFilename", () => {
  it("neutralizes CRLF so the header cannot be split", () => {
    const name = safeFilename(["timecard", "proj\r\nX-Injected: yes", "7d"]);
    expect(name).not.toMatch(/[\r\n]/);
    expect(name).toBe("timecard_proj-X-Injected-yes_7d");
  });

  it("strips quotes and path separators", () => {
    // `.` stays (filenames need it), but every separator is gone, so the
    // surviving dots cannot traverse anywhere.
    const out = safeFilename(['a"b', "../../etc/passwd"]);
    expect(out).toBe("a-b_..-..-etc-passwd");
    expect(out).not.toMatch(/[/\\"]/);
  });

  it("keeps ordinary slugs intact", () => {
    expect(safeFilename(["timecard", "dev-sales-dashboards", "30d"]))
      .toBe("timecard_dev-sales-dashboards_30d");
  });

  it("falls back rather than producing an empty name", () => {
    expect(safeFilename([undefined, "", "***"])).toBe("timecard");
  });

  it("bounds the total length", () => {
    expect(safeFilename(["x".repeat(500), "y".repeat(500)]).length).toBeLessThanOrEqual(120);
  });

  it("runs in linear time on a long dash run", () => {
    // Regression guard for CodeQL js/polynomial-redos (PR #418): the previous
    // `/^-+|-+$/` retried `-+$` from every position, so this input took
    // quadratic time. The two-pointer trim is linear — and the input is
    // truncated before sanitizing besides.
    const hostile = "-".repeat(200_000);
    const started = performance.now();
    const out = safeFilename([hostile]);
    expect(performance.now() - started).toBeLessThan(250);
    // An all-dash component trims to nothing, so the fallback applies.
    expect(out).toBe("timecard");
  });
});

describe("trimDashes", () => {
  it("trims only leading and trailing dashes", () => {
    expect(trimDashes("--a-b--")).toBe("a-b");
    expect(trimDashes("----")).toBe("");
    expect(trimDashes("")).toBe("");
    expect(trimDashes("ab")).toBe("ab");
  });
});
