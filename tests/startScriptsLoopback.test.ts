import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// #629 — the API is unauthenticated and local-only; a source run must not listen on every interface.

const root = path.resolve(__dirname, "..");

describe("source launches bind loopback only (#629)", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")) as { scripts: Record<string, string> };

  it.each(["dev", "start"])("pnpm %s passes -H 127.0.0.1", (name) => {
    expect(pkg.scripts[name]).toMatch(/(^|\s)-H 127\.0\.0\.1(\s|$)/);
  });

  it("the production screenshot script's `next start` does too", () => {
    const src = readFileSync(path.join(root, "scripts", "capture-screenshots-prod.mjs"), "utf-8");
    expect(src).toContain("['start', '-p', String(PORT), '-H', '127.0.0.1']");
  });
});
