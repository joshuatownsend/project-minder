import { describe, it, expect } from "vitest";
import { mapForeignPath, mapLocalPath } from "@/lib/pathMapping";
import type { PathMapping } from "@/lib/types";

const WSL: PathMapping[] = [
  { from: "/home/josh", to: "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh" },
];

describe("mapForeignPath (foreign → local)", () => {
  it("rewrites a mapped Linux path to the UNC view", () => {
    expect(mapForeignPath("/home/josh/dev/bamcli", WSL)).toBe(
      "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev\\bamcli"
    );
  });

  it("maps the prefix itself", () => {
    expect(mapForeignPath("/home/josh", WSL)).toBe(
      "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh"
    );
  });

  it("requires a separator boundary — /home/joshua is not /home/josh", () => {
    expect(mapForeignPath("/home/joshua/dev/x", WSL)).toBe("/home/joshua/dev/x");
  });

  it("is case-sensitive on the foreign side (Linux paths)", () => {
    expect(mapForeignPath("/HOME/josh/dev/x", WSL)).toBe("/HOME/josh/dev/x");
  });

  it("leaves Windows paths untouched", () => {
    expect(mapForeignPath("C:\\dev\\project-minder", WSL)).toBe("C:\\dev\\project-minder");
  });

  it("first matching mapping wins", () => {
    const mappings: PathMapping[] = [
      { from: "/home/josh/dev", to: "\\\\wsl.localhost\\U\\dev" },
      { from: "/home/josh", to: "\\\\wsl.localhost\\U\\home\\josh" },
    ];
    expect(mapForeignPath("/home/josh/dev/x", mappings)).toBe("\\\\wsl.localhost\\U\\dev\\x");
  });

  it("tolerates trailing separators on mapping endpoints", () => {
    const mappings: PathMapping[] = [
      { from: "/home/josh/", to: "\\\\wsl.localhost\\U\\home\\josh\\" },
    ];
    expect(mapForeignPath("/home/josh/dev", mappings)).toBe("\\\\wsl.localhost\\U\\home\\josh\\dev");
  });

  it("handles undefined/empty mappings", () => {
    expect(mapForeignPath("/home/josh/dev", undefined)).toBe("/home/josh/dev");
    expect(mapForeignPath("/home/josh/dev", [])).toBe("/home/josh/dev");
  });
});

describe("mapLocalPath (local → foreign)", () => {
  it("rewrites a UNC path back to the Linux form", () => {
    expect(mapLocalPath("\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev\\bamcli", WSL)).toBe(
      "/home/josh/dev/bamcli"
    );
  });

  it("matches the local prefix case-insensitively (Windows semantics)", () => {
    expect(mapLocalPath("\\\\WSL.LOCALHOST\\ubuntu-26.04\\home\\josh\\dev\\x", WSL)).toBe(
      "/home/josh/dev/x"
    );
  });

  it("treats forward slashes as equivalent in the local form", () => {
    expect(mapLocalPath("//wsl.localhost/Ubuntu-26.04/home/josh/dev/x", WSL)).toBe(
      "/home/josh/dev/x"
    );
  });

  it("leaves unmapped local paths untouched", () => {
    expect(mapLocalPath("C:\\dev\\project-minder", WSL)).toBe("C:\\dev\\project-minder");
  });

  it("round-trips with mapForeignPath", () => {
    const foreign = "/home/josh/dev/bamcli";
    expect(mapLocalPath(mapForeignPath(foreign, WSL), WSL)).toBe(foreign);
  });
});
