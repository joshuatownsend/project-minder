import { describe, it, expect } from "vitest";
import {
  buildCurlCommand,
  buildApprovalCurlCommand,
  deriveApprovalUrl,
  isManagedCommand,
  isApprovalCommand,
  SENTINEL_UA,
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
});
