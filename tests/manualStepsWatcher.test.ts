import { describe, it, expect } from "vitest";
import {
  manualStepEntryKey,
  diffNewManualStepEntries,
} from "@/lib/manualStepsWatcher";
import { ManualStepEntry } from "@/lib/types";

function entry(date: string, slug: string, title: string): ManualStepEntry {
  return { date, featureSlug: slug, title, steps: [] };
}

describe("manualStepEntryKey", () => {
  it("builds a stable date|slug|title signature", () => {
    expect(
      manualStepEntryKey(entry("2026-06-26 14:32", "auth", "Clerk setup"))
    ).toBe("2026-06-26 14:32|auth|Clerk setup");
  });
});

describe("diffNewManualStepEntries", () => {
  it("treats every entry as new against an empty seen set", () => {
    const entries = [
      entry("2026-06-26 10:00", "a", "One"),
      entry("2026-06-26 11:00", "b", "Two"),
    ];
    const { newEntries, keys } = diffNewManualStepEntries(new Set(), entries);
    expect(newEntries).toHaveLength(2);
    expect(keys.size).toBe(2);
  });

  it("reports nothing new when the file is unchanged (e.g. a checkbox toggle)", () => {
    const entries = [entry("2026-06-26 10:00", "a", "One")];
    const seen = diffNewManualStepEntries(new Set(), entries).keys;
    // A checkbox toggle does not change any header, so the key set is identical.
    const { newEntries } = diffNewManualStepEntries(seen, entries);
    expect(newEntries).toHaveLength(0);
  });

  it("detects a genuinely new appended entry", () => {
    const before = [entry("2026-06-26 10:00", "a", "One")];
    const seen = diffNewManualStepEntries(new Set(), before).keys;
    const after = [...before, entry("2026-06-26 12:00", "c", "Three")];
    const { newEntries } = diffNewManualStepEntries(seen, after);
    expect(newEntries.map((e) => e.title)).toEqual(["Three"]);
  });

  it("detects a new entry even when older entries are archived in the SAME edit", () => {
    // This is the regression the previous count+slice approach silently missed:
    // archiving 2 entries (count 2 -> 1) made `newCount > prevCount` false, so a
    // brand-new entry produced no notification.
    const before = [
      entry("2026-06-26 10:00", "a", "One"),
      entry("2026-06-26 11:00", "b", "Two"),
    ];
    const seen = diffNewManualStepEntries(new Set(), before).keys;
    const after = [entry("2026-06-26 12:00", "c", "Three")]; // One & Two archived
    const { newEntries, keys } = diffNewManualStepEntries(seen, after);
    expect(newEntries.map((e) => e.title)).toEqual(["Three"]);
    expect(keys.size).toBe(1);
  });

  it("reports nothing new when entries are only pruned/archived", () => {
    const before = [
      entry("2026-06-26 10:00", "a", "One"),
      entry("2026-06-26 11:00", "b", "Two"),
    ];
    const seen = diffNewManualStepEntries(new Set(), before).keys;
    const after = [entry("2026-06-26 10:00", "a", "One")]; // Two archived
    const { newEntries } = diffNewManualStepEntries(seen, after);
    expect(newEntries).toHaveLength(0);
  });

  it("is order-independent — reordering entries is not 'new'", () => {
    const a = entry("2026-06-26 10:00", "a", "One");
    const b = entry("2026-06-26 11:00", "b", "Two");
    const seen = diffNewManualStepEntries(new Set(), [a, b]).keys;
    const { newEntries } = diffNewManualStepEntries(seen, [b, a]);
    expect(newEntries).toHaveLength(0);
  });
});
