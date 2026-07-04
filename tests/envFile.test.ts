import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanEnvFiles } from "@/lib/scanner/envFile";

vi.mock("fs", () => ({
  promises: { readFile: vi.fn() },
}));
import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);

/**
 * Route reads so only the `.env` file resolves with `content`; every other
 * candidate (`.env.local`, `.env.example`, `.env.development`) rejects ENOENT.
 */
function onlyDotEnv(content: string) {
  mockReadFile.mockImplementation(async (p: unknown) => {
    const file = String(p);
    if (file.endsWith(".env")) return content;
    throw new Error("ENOENT");
  });
}

describe("scanEnvFiles — managed DB provider detection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets provider 'Neon' and adds it to externalServices for a Neon host", async () => {
    onlyDotEnv("DATABASE_URL=postgres://user:pass@ep-cool-1.us-east-2.aws.neon.tech/app\n");
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.database?.provider).toBe("Neon");
    expect(result.externalServices).toContain("Neon");
  });

  it("detects PlanetScale from a psdb.cloud host", async () => {
    onlyDotEnv("DATABASE_URL=mysql://user:pass@aws.connect.psdb.cloud/app?ssl=true\n");
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.database?.type).toBe("MySQL");
    expect(result.database?.provider).toBe("PlanetScale");
    expect(result.externalServices).toContain("PlanetScale");
  });

  it("detects Supabase, Upstash, Railway, and Render hosts", async () => {
    const cases: Array<[string, string]> = [
      ["postgres://u:p@db.abcdef.supabase.co/postgres", "Supabase"],
      ["postgres://u:p@host.upstash.io/db", "Upstash"],
      ["postgres://u:p@containers-us-west-1.railway.app/railway", "Railway"],
      ["postgres://u:p@dpg-xyz.render.com/app", "Render"],
    ];
    for (const [url, expected] of cases) {
      vi.clearAllMocks();
      onlyDotEnv(`DATABASE_URL=${url}\n`);
      const result = await scanEnvFiles("C:\\dev\\proj");
      expect(result.database?.provider).toBe(expected);
      expect(result.externalServices).toContain(expected);
    }
  });

  it("leaves provider undefined for a self-hosted host and adds no managed-provider service", async () => {
    onlyDotEnv("DATABASE_URL=postgres://user:pass@localhost:5432/app\n");
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.database?.host).toBe("localhost");
    expect(result.database?.provider).toBeUndefined();
    // None of the managed-DB provider names should appear.
    for (const name of ["Neon", "PlanetScale", "Supabase", "Upstash", "Railway", "Render"]) {
      expect(result.externalServices).not.toContain(name);
    }
  });
});

describe("scanEnvFiles — .env.example is excluded from detection (B7)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not report a database/provider when only .env.example has a placeholder DATABASE_URL", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const file = String(p);
      if (file.endsWith(".env.example")) {
        return "DATABASE_URL=postgres://user:pass@ep-cool-1.us-east-2.aws.neon.tech/app\nSTRIPE_SECRET_KEY=sk_test_placeholder\n";
      }
      throw new Error("ENOENT");
    });
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.database).toBeUndefined();
    expect(result.externalServices).toEqual([]);
    // .env.example must never even be read for detection purposes.
    for (const call of mockReadFile.mock.calls) {
      expect(String(call[0])).not.toMatch(/\.env\.example$/);
    }
  });

  it("still detects a real DATABASE_URL from .env even when .env.example also exists with a placeholder", async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      const file = String(p);
      if (file.endsWith(".env.example")) {
        return "DATABASE_URL=postgres://placeholder@fake-example-host.neon.tech/app\n";
      }
      if (file.endsWith(".env")) {
        return "DATABASE_URL=postgres://user:pass@localhost:5432/realapp\n";
      }
      throw new Error("ENOENT");
    });
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.database?.host).toBe("localhost");
    expect(result.database?.name).toBe("realapp");
  });
});

describe("scanEnvFiles — key-name service detection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("still detects Stripe by key name (regression guard)", async () => {
    onlyDotEnv("STRIPE_SECRET_KEY=sk_test_123\n");
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.externalServices).toContain("Stripe");
  });

  it("detects PlanetScale from a dedicated PLANETSCALE_DB key alone", async () => {
    onlyDotEnv("PLANETSCALE_DB=my-db\n");
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.externalServices).toContain("PlanetScale");
    // No DATABASE_URL present, so no parsed database.
    expect(result.database).toBeUndefined();
  });

  it("returns empty results when no env files exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await scanEnvFiles("C:\\dev\\proj");
    expect(result.database).toBeUndefined();
    expect(result.externalServices).toEqual([]);
  });
});
