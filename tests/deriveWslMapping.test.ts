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
  });

  it("returns null for a path that isn't a Claude home", () => {
    expect(deriveWslMapping("\\\\wsl.localhost\\Ubuntu\\home\\josh")).toBeNull();
    expect(deriveWslMapping("\\\\wsl.localhost\\Ubuntu")).toBeNull();
    expect(deriveWslMapping("\\\\wsl.localhost\\Ubuntu\\.claude")).toBeNull();
  });

  // Behaviour change (#326): this used to return null, because the old regex
  // hardcoded `/home/<user>`. That was a limitation rather than a requirement —
  // /root/.claude IS the root user's Claude home, and refusing to map it meant
  // root-user WSL setups could never correlate their sessions. The shared
  // derivation takes whatever directory contains `.claude` as the home.
  it("maps a home outside /home, including root's", () => {
    expect(deriveWslMapping("\\\\wsl.localhost\\Ubuntu\\root\\.claude")).toEqual({
      from: "/root",
      to: "\\\\wsl.localhost\\Ubuntu\\root",
    });
  });

  it("keeps the full prefix for a deeply-nested home", () => {
    // Delegating to the scan-root derivation would have mapped this to "/opt" —
    // a prefix broad enough to swallow unrelated paths.
    expect(deriveWslMapping("\\\\wsl.localhost\\Ubuntu\\opt\\myuser\\.claude")).toEqual({
      from: "/opt/myuser",
      to: "\\\\wsl.localhost\\Ubuntu\\opt\\myuser",
    });
  });
});
