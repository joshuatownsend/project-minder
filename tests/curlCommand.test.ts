import { describe, it, expect } from "vitest";
import {
  buildCurlCommand,
  buildApprovalCurlCommand,
  deriveApprovalUrl,
  isManagedCommand,
  isApprovalCommand,
  SENTINEL_UA,
  safeHookUrl,
} from "@/lib/hooks/curlCommand";

describe("buildCurlCommand", () => {
  const url = "http://localhost:4100/api/hooks";
  const cmd = buildCurlCommand(url);

  it("includes the hook URL", () => {
    expect(cmd).toContain(`"${url}"`);
  });

  it("sets Content-Type to application/json", () => {
    expect(cmd).toContain("Content-Type: application/json");
  });

  it("reads stdin via --data-binary @-", () => {
    expect(cmd).toContain("--data-binary @-");
  });

  it("embeds the sentinel User-Agent", () => {
    expect(cmd).toContain(SENTINEL_UA);
  });

  it("uses silent mode (-sS)", () => {
    expect(cmd).toContain("-sS");
  });

  it("uses double quotes (cross-platform compatible)", () => {
    // All quotes in the command should be double quotes, not single
    expect(cmd).not.toContain("'");
  });
});

describe("isManagedCommand", () => {
  it("recognizes commands containing the sentinel", () => {
    expect(isManagedCommand(buildCurlCommand("http://localhost:4100/api/hooks"))).toBe(true);
  });

  it("rejects commands without the sentinel", () => {
    expect(isManagedCommand("curl -X POST http://example.com")).toBe(false);
  });

  it("also matches the approval sentinel, so uninstall removes both kinds", () => {
    const approval = buildApprovalCurlCommand("http://localhost:4100/api/hooks/permission", 60_000);
    expect(isManagedCommand(approval)).toBe(true);
    expect(isApprovalCommand(approval)).toBe(true);
  });

  it("isApprovalCommand does NOT match the lifecycle command", () => {
    // The narrower test is what lets the installer upgrade an existing
    // install: the coarse one is already true for its PreToolUse entry.
    expect(isApprovalCommand(buildCurlCommand("http://localhost:4100/api/hooks"))).toBe(false);
  });
});

describe("deriveApprovalUrl", () => {
  it("appends the /permission segment", () => {
    expect(deriveApprovalUrl("http://localhost:4100/api/hooks")).toBe(
      "http://localhost:4100/api/hooks/permission",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(deriveApprovalUrl("http://localhost:4100/api/hooks/")).toBe(
      "http://localhost:4100/api/hooks/permission",
    );
  });

  it("drops query and fragment rather than appending after them", () => {
    // Naive concatenation would produce `…?x=1/permission`, i.e. a URL whose
    // path is still /api/hooks — silently posting to the wrong receiver.
    expect(deriveApprovalUrl("http://localhost:4100/api/hooks?x=1#frag")).toBe(
      "http://localhost:4100/api/hooks/permission",
    );
  });

  it("preserves a non-default port", () => {
    expect(deriveApprovalUrl("http://127.0.0.1:9999/api/hooks")).toContain("127.0.0.1:9999");
  });

  it("handles a long run of trailing slashes in linear time", () => {
    // The obvious `replace(/\/+$/, "")` backtracks quadratically here, and
    // this input arrives over HTTP. 50k slashes finishes instantly with the
    // character scan and visibly stalls with the regex.
    const start = Date.now();
    const out = deriveApprovalUrl("http://localhost:4100/api/hooks" + "/".repeat(50_000));
    expect(out).toBe("http://localhost:4100/api/hooks/permission");
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

// #631 — the hook URL is interpolated into a shell command stored in user-wide Claude settings.
describe("safeHookUrl / command injection (#631)", () => {
  it("accepts plain loopback http(s) URLs and returns the normalized form", () => {
    expect(safeHookUrl("http://localhost:4100/api/hooks")).toBe("http://localhost:4100/api/hooks");
    expect(safeHookUrl("http://127.0.0.1:4100/api/hooks/")).toBe("http://127.0.0.1:4100/api/hooks/");
    expect(safeHookUrl("https://[::1]:4100/a_b-c.d")).toBe("https://[::1]:4100/a_b-c.d");
  });

  it.each([
    'http://localhost:4100/$(touch pwned)',
    'http://localhost:4100/"; touch pwned; "',
    "http://localhost:4100/`id`",
    "http://localhost:4100/a b",
    "http://localhost:4100/a;b",
    "http://localhost:4100/a&b",
    "http://localhost:4100/a|b",
    "http://localhost:4100/%PATH%",
    "http://localhost:4100/a?x=1",
    "http://localhost:4100/a#x",
    "http://user:pw@localhost:4100/a",
    "http://evil.example/a",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s", (u) => {
    expect(safeHookUrl(u)).toBeNull();
  });

  it("normalizes a backslash to a path separator, so none reaches the command line", () => {
    expect(safeHookUrl(String.raw`http://localhost:4100/a\b`)).toBe("http://localhost:4100/a/b");
  });

  it("both command builders refuse an unsafe URL instead of embedding it", () => {
    const evil = 'http://localhost:4100/$(touch pwned)';
    expect(() => buildCurlCommand(evil)).toThrow();
    expect(() => buildApprovalCurlCommand(evil, 60_000)).toThrow();
  });
});
