export type ShortcutActionId =
  | "focus-search"
  | "open-quick-add"
  | "cycle-view-mode"
  | "rescan-projects"
  | "open-help"
  | "open-command-palette";

export const DEFAULT_SHORTCUTS: Record<ShortcutActionId, string> = {
  "focus-search": "/",
  "open-quick-add": "Shift+T",
  "cycle-view-mode": "v",
  "rescan-projects": "r",
  "open-help": "?",
  "open-command-palette": "Ctrl+K",
};

export const SHORTCUT_LABELS: Record<ShortcutActionId, string> = {
  "focus-search": "Focus search",
  "open-quick-add": "Quick-add project",
  "cycle-view-mode": "Cycle view mode",
  "rescan-projects": "Rescan projects",
  "open-help": "Open help",
  "open-command-palette": "Command palette",
};

const ACTION_ID_SET = new Set<string>([
  "focus-search",
  "open-quick-add",
  "cycle-view-mode",
  "rescan-projects",
  "open-help",
  "open-command-palette",
]);

export function isShortcutActionId(s: string): s is ShortcutActionId {
  return ACTION_ID_SET.has(s);
}

// Combo regex: optional "Mod+" prefixes followed by a single printable character.
// The key can be a letter, digit, or common punctuation produced by a single keypress.
const COMBO_RE = /^((Ctrl|Meta|Alt|Shift)\+)*[A-Za-z0-9/?.,;'"`~!@#$%^&*()\-_+=[\]{}|:<>\\]$/;

export function isValidCombo(combo: string): boolean {
  return COMBO_RE.test(combo);
}

export interface ParsedCombo {
  mods: Set<"Ctrl" | "Meta" | "Alt" | "Shift">;
  key: string;
}

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split("+");
  const mods = new Set<"Ctrl" | "Meta" | "Alt" | "Shift">();
  let key = "";
  for (const part of parts) {
    if (part === "Ctrl" || part === "Meta" || part === "Alt" || part === "Shift") {
      mods.add(part);
    } else {
      key = part;
    }
  }
  return { mods, key };
}

/**
 * Returns true when the keyboard event matches the given combo string.
 *
 * Key matching rules:
 * - Ctrl/Meta/Alt: checked against event modifier flags.
 * - Shift: NOT checked as a separate flag. Instead, the `key` portion of the
 *   combo is the actual `e.key` value the browser produces. For combos like
 *   "Shift+T", the key is "T" (uppercase, produced when Shift is held), so the
 *   uppercase comparison handles Shift implicitly. For "?" the key is "?" (the
 *   shifted / character), so no explicit Shift check is needed.
 * - Ctrl/Meta shortcuts: compared case-insensitively because browsers do not
 *   shift key values when Ctrl/Meta is held (Ctrl+K → e.key === "k").
 */
export function isShortcutMatch(combo: string, e: KeyboardEvent): boolean {
  const { mods, key } = parseCombo(combo);
  if (e.ctrlKey !== mods.has("Ctrl")) return false;
  if (e.metaKey !== mods.has("Meta")) return false;
  if (e.altKey !== mods.has("Alt")) return false;
  if (mods.has("Ctrl") || mods.has("Meta")) {
    return e.key.toLowerCase() === key.toLowerCase();
  }
  return e.key === key;
}

/** Builds the effective shortcut map by merging defaults with user overrides. */
export function effectiveShortcuts(
  overrides: Record<string, string> | undefined
): Record<ShortcutActionId, string> {
  if (!overrides || Object.keys(overrides).length === 0) return DEFAULT_SHORTCUTS;
  const result = { ...DEFAULT_SHORTCUTS };
  for (const [id, combo] of Object.entries(overrides)) {
    if (isShortcutActionId(id)) result[id] = combo;
  }
  return result;
}
