import { describe, it, expect } from "vitest";
import { presenceFlags } from "@/lib/groups/presence";

const labels = { win: "C:", wsl: "WSL Ubuntu", d: "D:" };
const members = ["win", "wsl", "d"];

describe("presenceFlags", () => {
  it("returns nothing when every location agrees", () => {
    expect(presenceFlags({ presentIn: members, memberSlugs: members, labels })).toEqual([]);
    expect(
      presenceFlags({ presentIn: members, memberSlugs: members, labels, completedIn: members, statusIn: { win: "done", wsl: "done", d: "done" }, editedIn: [] })
    ).toEqual([]);
  });

  it("returns nothing when nothing is present anywhere (a fact no member defines)", () => {
    expect(presenceFlags({ presentIn: [], memberSlugs: members, labels })).toEqual([]);
  });

  it("says 'only in' when the present list is the shorter one, 'not in' otherwise", () => {
    expect(presenceFlags({ presentIn: ["win"], memberSlugs: members, labels }).map((f) => f.text)).toEqual(["only in C:"]);
    expect(presenceFlags({ presentIn: ["win", "wsl"], memberSlugs: members, labels }).map((f) => f.text)).toEqual(["not in D:"]);
    // A tie (1 of 2) reads as "only in".
    expect(presenceFlags({ presentIn: ["win"], memberSlugs: ["win", "wsl"], labels }).map((f) => f.text)).toEqual(["only in C:"]);
  });

  it("flags a partial completion with the given verb and lists the open side in the title", () => {
    const [f] = presenceFlags({ presentIn: ["win", "wsl"], memberSlugs: ["win", "wsl"], labels, completedIn: ["wsl"], doneWord: "checked" });
    expect(f).toEqual({ key: "done", text: "checked in WSL Ubuntu", title: "checked in WSL Ubuntu; open in C:" });
  });

  it("does not flag completion when done everywhere or nowhere", () => {
    const base = { presentIn: ["win", "wsl"], memberSlugs: ["win", "wsl"], labels };
    expect(presenceFlags({ ...base, completedIn: [] })).toEqual([]);
    expect(presenceFlags({ ...base, completedIn: ["win", "wsl"] })).toEqual([]);
  });

  it("emits one chip per location only when statuses disagree", () => {
    const base = { presentIn: ["win", "wsl"], memberSlugs: ["win", "wsl"], labels };
    expect(presenceFlags({ ...base, statusIn: { win: "doing", wsl: "doing" } })).toEqual([]);
    expect(presenceFlags({ ...base, statusIn: { win: "doing", wsl: "done" } }).map((f) => f.text)).toEqual(["C: → doing", "WSL Ubuntu → done"]);
  });

  it("flags edits and falls back to the slug when a label is missing", () => {
    const flags = presenceFlags({ presentIn: ["win", "x"], memberSlugs: ["win", "x"], labels, editedIn: ["x"] });
    expect(flags).toEqual([{ key: "edited", text: "edited in x", title: "Differs in x" }]);
  });

  it("stacks flags in a stable order: presence, completion, status, edits", () => {
    const keys = presenceFlags({
      presentIn: ["win", "wsl"],
      memberSlugs: members,
      labels,
      completedIn: ["win"],
      statusIn: { win: "done", wsl: "todo" },
      editedIn: ["wsl"],
    }).map((f) => f.key);
    expect(keys).toEqual(["missing", "done", "status:win", "status:wsl", "edited"]);
  });
});
