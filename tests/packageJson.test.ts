import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanPackageJson } from "@/lib/scanner/packageJson";

vi.mock("fs", () => ({
  promises: { readFile: vi.fn() },
}));
import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);

function withDevScript(devScript: string) {
  mockReadFile.mockResolvedValue(
    JSON.stringify({ scripts: { dev: devScript } })
  );
}

describe("scanPackageJson — devPort parsing (B6)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses --port N (space form)", async () => {
    withDevScript("next dev --port 4100");
    const result = await scanPackageJson("C:\\dev\\proj");
    expect(result.devPort).toBe(4100);
  });

  it("parses --port=N (equals form)", async () => {
    withDevScript("next dev --port=4100");
    const result = await scanPackageJson("C:\\dev\\proj");
    expect(result.devPort).toBe(4100);
  });

  it("parses -pN (no-space short form)", async () => {
    withDevScript("vite -p4100");
    const result = await scanPackageJson("C:\\dev\\proj");
    expect(result.devPort).toBe(4100);
  });

  it("parses -p N (space short form)", async () => {
    withDevScript("vite -p 4100");
    const result = await scanPackageJson("C:\\dev\\proj");
    expect(result.devPort).toBe(4100);
  });

  it("parses PORT=N env-prefix form (regression guard)", async () => {
    withDevScript("PORT=3001 node server.js");
    const result = await scanPackageJson("C:\\dev\\proj");
    expect(result.devPort).toBe(3001);
  });

  it("defaults next dev with no explicit port to 3000", async () => {
    withDevScript("next dev");
    const result = await scanPackageJson("C:\\dev\\proj");
    expect(result.devPort).toBe(3000);
  });
});
