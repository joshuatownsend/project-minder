import { describe, it, expect } from "vitest";
import {
  parseCombo,
  isShortcutMatch,
  isValidCombo,
  isShortcutActionId,
  effectiveShortcuts,
  DEFAULT_SHORTCUTS,
} from "@/lib/keyboardShortcuts";

function syntheticEvent(key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  } as KeyboardEvent;
}

describe("parseCombo", () => {
  it("parses plain key", () => {
    const { mods, key } = parseCombo("/");
    expect(key).toBe("/");
    expect(mods.size).toBe(0);
  });

  it("parses Ctrl+K", () => {
    const { mods, key } = parseCombo("Ctrl+K");
    expect(mods.has("Ctrl")).toBe(true);
    expect(key).toBe("K");
  });

  it("parses Shift+T", () => {
    const { mods, key } = parseCombo("Shift+T");
    expect(mods.has("Shift")).toBe(true);
    expect(key).toBe("T");
  });

  it("parses multi-modifier Ctrl+Shift+K", () => {
    const { mods, key } = parseCombo("Ctrl+Shift+K");
    expect(mods.has("Ctrl")).toBe(true);
    expect(mods.has("Shift")).toBe(true);
    expect(key).toBe("K");
  });
});

describe("isShortcutMatch", () => {
  it("matches plain slash", () => {
    expect(isShortcutMatch("/", syntheticEvent("/"))).toBe(true);
  });

  it("rejects Ctrl+/ for plain slash", () => {
    expect(isShortcutMatch("/", syntheticEvent("/", { ctrl: true }))).toBe(false);
  });

  it("matches Ctrl+K case-insensitively (e.key is lowercase when Ctrl held)", () => {
    expect(isShortcutMatch("Ctrl+K", syntheticEvent("k", { ctrl: true }))).toBe(true);
    expect(isShortcutMatch("Ctrl+K", syntheticEvent("K", { ctrl: true }))).toBe(true);
  });

  it("matches Shift+T via uppercase e.key", () => {
    expect(isShortcutMatch("Shift+T", syntheticEvent("T"))).toBe(true);
  });

  it("does not match lowercase t for Shift+T combo", () => {
    expect(isShortcutMatch("Shift+T", syntheticEvent("t"))).toBe(false);
  });

  it("matches ? (Shift is baked into the character)", () => {
    expect(isShortcutMatch("?", syntheticEvent("?"))).toBe(true);
  });

  it("rejects ? when Ctrl is held", () => {
    expect(isShortcutMatch("?", syntheticEvent("?", { ctrl: true }))).toBe(false);
  });

  it("matches v without modifiers", () => {
    expect(isShortcutMatch("v", syntheticEvent("v"))).toBe(true);
  });

  it("rejects v when Ctrl is held", () => {
    expect(isShortcutMatch("v", syntheticEvent("v", { ctrl: true }))).toBe(false);
  });
});

describe("isValidCombo", () => {
  it("accepts plain characters", () => {
    expect(isValidCombo("/")).toBe(true);
    expect(isValidCombo("v")).toBe(true);
    expect(isValidCombo("?")).toBe(true);
  });

  it("accepts modifier combos", () => {
    expect(isValidCombo("Ctrl+K")).toBe(true);
    expect(isValidCombo("Shift+T")).toBe(true);
    expect(isValidCombo("Meta+K")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidCombo("")).toBe(false);
  });

  it("rejects multi-character key without modifier", () => {
    expect(isValidCombo("Enter")).toBe(false);
    expect(isValidCombo("ArrowDown")).toBe(false);
  });
});

describe("isShortcutActionId", () => {
  it("accepts valid action ids", () => {
    expect(isShortcutActionId("focus-search")).toBe(true);
    expect(isShortcutActionId("open-command-palette")).toBe(true);
  });

  it("rejects unknown ids", () => {
    expect(isShortcutActionId("does-not-exist")).toBe(false);
    expect(isShortcutActionId("")).toBe(false);
  });
});

describe("effectiveShortcuts", () => {
  it("returns defaults when no overrides", () => {
    const eff = effectiveShortcuts(undefined);
    expect(eff["focus-search"]).toBe(DEFAULT_SHORTCUTS["focus-search"]);
  });

  it("applies valid overrides on top of defaults", () => {
    const eff = effectiveShortcuts({ "focus-search": "s" });
    expect(eff["focus-search"]).toBe("s");
    expect(eff["open-command-palette"]).toBe(DEFAULT_SHORTCUTS["open-command-palette"]);
  });

  it("ignores unknown action ids in overrides", () => {
    const eff = effectiveShortcuts({ "not-a-real-action": "x" });
    // All defaults still present; unknown key discarded
    expect(Object.keys(eff)).toEqual(Object.keys(DEFAULT_SHORTCUTS));
  });
});

describe("conflict detection (mirrors PATCH validator logic)", () => {
  function findConflict(overrides: Record<string, string>): string | null {
    const merged = effectiveShortcuts(overrides);
    const seen = new Map<string, string>();
    for (const [id, combo] of Object.entries(merged)) {
      if (seen.has(combo)) return `"${combo}" used by both "${seen.get(combo)}" and "${id}"`;
      seen.set(combo, id);
    }
    return null;
  }

  it("detects conflict when patch collides with an existing default", () => {
    // cycle-view-mode defaults to "v"; reassigning focus-search to "v" must be rejected
    const conflict = findConflict({ "focus-search": "v" });
    expect(conflict).not.toBeNull();
    expect(conflict).toContain('"v"');
  });

  it("no conflict when overriding one default and vacating the original", () => {
    // Reassign focus-search to "g" (unused); original "/" is now free — no dupe
    const conflict = findConflict({ "focus-search": "g" });
    expect(conflict).toBeNull();
  });

  it("detects conflict when two overrides share the same combo", () => {
    const conflict = findConflict({ "focus-search": "x", "open-help": "x" });
    expect(conflict).not.toBeNull();
    expect(conflict).toContain('"x"');
  });
});
