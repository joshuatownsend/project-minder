import { describe, it, expect } from "vitest";
import { buildCurlCommand, isManagedCommand, SENTINEL_UA } from "@/lib/hooks/curlCommand";

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
});
