// @vitest-environment node
import { describe, it, expect } from "vitest";
import { deriveWslMapping } from "@/components/settings/ClaudeHomesSection";

describe("deriveWslMapping", () => {
  it("derives the implied mapping from a wsl.localhost claude home", () => {
    expect(deriveWslMapping("\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\.claude")).toEqual({
      from: "/home/josh",
      to: "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh",
    });
  });

  it("supports the legacy wsl$ host and trailing separator", () => {
    expect(deriveWslMapping("\\\\wsl$\\Debian\\home\\amy\\.claude\\")).toEqual({
      from: "/home/amy",
      to: "\\\\wsl$\\Debian\\home\\amy",
    });
  });

  it("supports distro names with spaces and forward slashes", () => {
    expect(deriveWslMapping("//wsl.localhost/My Distro/home/josh/.claude")).toEqual({
      from: "/home/josh",
      to: "\\\\wsl.localhost\\My Distro\\home\\josh",
    });
  });

  it("returns null for non-WSL homes", () => {
    expect(deriveWslMapping("C:\\Users\\joshu\\.claude")).toBeNull();
    expect(deriveWslMapping("\\\\server\\share\\home\\x\\.claude")).toBeNull();
    expect(deriveWslMapping("\\\\wsl.localhost\\Ubuntu\\root\\.claude")).toBeNull();
  });
});
