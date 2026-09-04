import { describe, it, expect, vi, beforeEach } from "vitest";

// Never-wake: the resolver must decide from `partitionClaudeHomes`' verdict
// alone, so both it and the config read are mocked — no path is probed.
vi.mock("@/lib/claudeHome", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/claudeHome")>();
  return {
    ...real,
    getPrimaryClaudeHome: () => "C:\\Users\\me\\.claude",
    partitionClaudeHomes: vi.fn(),
  };
});
vi.mock("@/lib/config", () => ({ readConfig: vi.fn() }));

import { partitionClaudeHomes } from "@/lib/claudeHome";
import { readConfig } from "@/lib/config";
import { normalizePathKey } from "@/lib/platform";
import { resolveCatalogHome, primaryCatalogHome, CatalogHomeError } from "@/lib/indexer/homes";

const PRIMARY = "C:\\Users\\me\\.claude";
const UBUNTU = "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude";
const DEBIAN = "\\\\wsl.localhost\\Debian\\home\\me\\.claude";
const key = normalizePathKey;

const mappings = [
  { from: "/home/me", to: "\\\\wsl.localhost\\Ubuntu\\home\\me" },
  { from: "/home/me", to: "\\\\wsl.localhost\\Debian\\home\\me" },
  { from: "/srv", to: "D:\\srv" },
];

beforeEach(() => {
  vi.mocked(readConfig).mockResolvedValue({ pathMappings: mappings } as never);
  vi.mocked(partitionClaudeHomes).mockResolvedValue({
    readable: [PRIMARY, UBUNTU],
    unavailable: [{ path: DEBIAN, distro: "Debian", reason: "wsl-stopped" }],
  });
});

describe("resolveCatalogHome", () => {
  it("is the primary home with no key, without reading config or probing anything", async () => {
    const h = await resolveCatalogHome();
    expect(h).toEqual(primaryCatalogHome());
    expect(h.primary).toBe(true);
    expect(h.mappings).toEqual([]);
    expect(readConfig).not.toHaveBeenCalled();
    expect(partitionClaudeHomes).not.toHaveBeenCalled();
  });

  it("treats the primary's own key as the primary, also without a probe", async () => {
    const h = await resolveCatalogHome(key(PRIMARY));
    expect(h.primary).toBe(true);
    expect(partitionClaudeHomes).not.toHaveBeenCalled();
  });

  it("resolves a readable configured home by key, with its mappings scoped to that distro", async () => {
    const h = await resolveCatalogHome(key(UBUNTU));
    expect(h.primary).toBe(false);
    expect(h.path).toBe(UBUNTU);
    expect(h.key).toBe(key(UBUNTU));
    // The Debian mapping shares `/home/me` and must not apply to Ubuntu's
    // registry; the non-WSL mapping applies everywhere.
    expect(h.mappings).toEqual([mappings[0], mappings[2]]);
  });

  it("refuses a configured home that is unreadable this cycle, carrying the reason, as 503", async () => {
    const err = await resolveCatalogHome(key(DEBIAN)).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogHomeError);
    expect(err).toMatchObject({ problem: "unavailable", reason: "wsl-stopped", distro: "Debian", status: 503 });
  });

  it("refuses a key no configured home has, as 404", async () => {
    const err = await resolveCatalogHome("//wsl.localhost/arch/home/me/.claude").catch((e) => e);
    expect(err).toBeInstanceOf(CatalogHomeError);
    expect(err).toMatchObject({ problem: "unknown", status: 404 });
  });
});
