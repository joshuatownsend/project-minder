import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRate, getRatesSync, _resetForTesting } from "@/lib/fxRates";
import * as fs from "fs";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: vi.fn(),
      readFile: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const mockedFs = vi.mocked(fs.promises);

const FAKE_RATES = { EUR: 0.9, GBP: 0.79, JPY: 150.5 };
const FAKE_CACHE = JSON.stringify({ fetchedAt: new Date().toISOString(), rates: FAKE_RATES });

describe("fxRates", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it("returns 1 for USD without any fetch", async () => {
    const rate = await getRate("USD");
    expect(rate).toBe(1);
  });

  it("loads from disk cache when fresh", async () => {
    mockedFs.stat.mockResolvedValueOnce({ mtimeMs: Date.now() - 1000 } as unknown as import("fs").Stats);
    mockedFs.readFile.mockResolvedValueOnce(FAKE_CACHE);

    const rate = await getRate("EUR");
    expect(rate).toBeCloseTo(0.9);
    expect(mockedFs.readFile).toHaveBeenCalledOnce();
  });

  it("returns 1 as fallback when currency not in rates map", async () => {
    mockedFs.stat.mockResolvedValueOnce({ mtimeMs: Date.now() - 1000 } as unknown as import("fs").Stats);
    mockedFs.readFile.mockResolvedValueOnce(FAKE_CACHE);

    const rate = await getRate("ZZZ");
    expect(rate).toBe(1);
  });

  it("returns {} from getRatesSync before any load", () => {
    expect(getRatesSync()).toEqual({});
  });

  it("returns populated map from getRatesSync after load", async () => {
    mockedFs.stat.mockResolvedValueOnce({ mtimeMs: Date.now() - 1000 } as unknown as import("fs").Stats);
    mockedFs.readFile.mockResolvedValueOnce(FAKE_CACHE);
    await getRate("EUR");
    expect(getRatesSync()).toEqual(FAKE_RATES);
  });

  it("falls back to empty map when disk cache is absent and fetch fails", async () => {
    mockedFs.stat.mockRejectedValueOnce(new Error("ENOENT"));
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("network error")) as typeof fetch;
    try {
      const rate = await getRate("EUR");
      expect(rate).toBe(1); // fallback
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("deduplicates concurrent loads", async () => {
    mockedFs.stat.mockResolvedValue({ mtimeMs: Date.now() - 1000 } as unknown as import("fs").Stats);
    mockedFs.readFile.mockResolvedValue(FAKE_CACHE);

    const [r1, r2] = await Promise.all([getRate("JPY"), getRate("GBP")]);
    expect(r1).toBeCloseTo(150.5);
    expect(r2).toBeCloseTo(0.79);
    // Only one actual readFile call despite two concurrent getRate calls
    expect(mockedFs.readFile).toHaveBeenCalledOnce();
  });
});
