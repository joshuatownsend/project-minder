import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the fs and os modules before importing the route handler
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("os", () => ({
  homedir: () => "/home/user",
}));

vi.mock("path", async (importOriginal) => {
  const real = await importOriginal<typeof import("path")>();
  return {
    ...real,
    join: real.join,
    resolve: real.resolve,
  };
});

import * as fs from "fs";

describe("GET /api/insights-report", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns exists:false when report file is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { GET } = await import("@/app/api/insights-report/route");
    const res = await GET();
    const data = await res.json();
    expect(data.exists).toBe(false);
    expect(data.html).toBeNull();
  });

  it("returns sanitized html when file exists", async () => {
    const mtime = new Date("2026-05-04T23:36:00Z");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtime, size: 1024 } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(
      "<html><body><script>alert('xss')</script><p onclick=\"bad()\">Hello</p></body></html>"
    );
    const { GET } = await import("@/app/api/insights-report/route");
    const res = await GET();
    const data = await res.json();
    expect(data.exists).toBe(true);
    expect(data.html).not.toContain("<script>");
    expect(data.html).not.toContain("onclick");
    expect(data.html).toContain("Hello");
    expect(data.mtime).toBe(mtime.toISOString());
  });

  it("strips inline event handlers", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtime: new Date(), size: 100 } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '<a href="#" onmouseover="evil()">link</a><button onkeydown="evil()">btn</button>'
    );
    const { GET } = await import("@/app/api/insights-report/route");
    const res = await GET();
    const data = await res.json();
    expect(data.html).not.toContain("onmouseover");
    expect(data.html).not.toContain("onkeydown");
    expect(data.html).toContain("link");
  });
});
