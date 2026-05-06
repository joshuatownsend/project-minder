import { describe, it, expect } from "vitest";
import { relPath } from "@/components/viz/relPath";

describe("relPath", () => {
  it("returns src/ subtree when present", () => {
    expect(relPath("C:/dev/my-app/src/components/Foo.tsx")).toBe("src/components/Foo.tsx");
  });

  it("handles Windows backslash paths", () => {
    expect(relPath("C:\\dev\\my-app\\src\\lib\\utils.ts")).toBe("src/lib/utils.ts");
  });

  it("falls back to last segment when no /src/", () => {
    expect(relPath("/home/user/project/package.json")).toBe("package.json");
  });

  it("returns the full path when no slash at all", () => {
    expect(relPath("package.json")).toBe("package.json");
  });

  it("handles deep nested src paths", () => {
    expect(relPath("/repo/src/app/api/sessions/[id]/route.ts")).toBe("src/app/api/sessions/[id]/route.ts");
  });
});
