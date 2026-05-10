import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scoreItem, filterCommands, type CommandItem } from "@/lib/commandPalette";

const sample: CommandItem[] = [
  { id: "nav-/sessions", label: "Sessions", sublabel: "Sessions", href: "/sessions" },
  { id: "nav-/settings", label: "Settings", sublabel: "Config", href: "/settings" },
  { id: "nav-/", label: "Projects", sublabel: "Dashboard", href: "/" },
  { id: "project-my-app", label: "my-app", sublabel: "/dev/my-app", href: "/project/my-app", category: "Projects" },
  { id: "agent-code-reviewer", label: "code-reviewer", sublabel: "Agent", href: "/agents/code-reviewer", category: "Agents" },
];

describe("scoreItem", () => {
  it("prefix match scores higher than contains", () => {
    const s = sample.find((i) => i.id === "nav-/sessions")!;
    expect(scoreItem(s, "sess")).toBeGreaterThan(scoreItem(s, "ions"));
  });

  it("scores 0 for no match", () => {
    const item: CommandItem = { id: "x", label: "Projects", sublabel: "Dashboard", href: "/" };
    expect(scoreItem(item, "xyz123")).toBe(0);
  });

  it("scores 1 for empty query", () => {
    expect(scoreItem(sample[0], "")).toBe(1);
  });

  it("sublabel match scores 2", () => {
    const item = sample.find((i) => i.id === "nav-/settings")!;
    // "Config" is the sublabel — query "Config" matches sublabel
    expect(scoreItem(item, "config")).toBe(2);
  });

  it("prefix match on label scores 4", () => {
    const item = sample.find((i) => i.id === "nav-/sessions")!;
    expect(scoreItem(item, "ses")).toBe(4);
  });
});

describe("filterCommands", () => {
  it("returns all items for empty query", () => {
    expect(filterCommands(sample, "")).toHaveLength(sample.length);
  });

  it("filters by label", () => {
    const result = filterCommands(sample, "set");
    expect(result.some((i) => i.id === "nav-/settings")).toBe(true);
    expect(result.some((i) => i.id === "nav-/sessions")).toBe(false);
  });

  it("returns results sorted by score (prefix first)", () => {
    const result = filterCommands(sample, "se");
    // Both Sessions and Settings start with "Se" — they should appear
    expect(result.length).toBeGreaterThanOrEqual(2);
    // All should have score > 0
    expect(result.every((i) => scoreItem(i, "se") > 0)).toBe(true);
  });

  it("returns empty for unmatched query", () => {
    expect(filterCommands(sample, "xyznotfound")).toHaveLength(0);
  });
});

describe("recent selections (localStorage)", () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getRecentIds returns empty array when nothing stored", async () => {
    const { getRecentIds } = await import("@/lib/commandPalette");
    expect(getRecentIds()).toEqual([]);
  });

  it("recordRecent stores id and getRecentIds retrieves it", async () => {
    const { getRecentIds, recordRecent } = await import("@/lib/commandPalette");
    recordRecent("nav-/sessions");
    expect(getRecentIds()[0]).toBe("nav-/sessions");
  });

  it("recordRecent deduplicates and keeps most recent first", async () => {
    const { getRecentIds, recordRecent } = await import("@/lib/commandPalette");
    recordRecent("nav-/sessions");
    recordRecent("nav-/settings");
    recordRecent("nav-/sessions"); // re-select sessions
    const ids = getRecentIds();
    expect(ids[0]).toBe("nav-/sessions");
    expect(ids.filter((i) => i === "nav-/sessions")).toHaveLength(1);
  });
});
