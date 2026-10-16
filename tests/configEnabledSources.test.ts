import { describe, it, expect } from "vitest";
import { enabledSources } from "@/lib/config";
import type { MinderConfig } from "@/lib/types";

// The one definition of which sources /api/sessions lists and session search
// covers (#706).
const cfg = (enabledAdapters?: string[]) => ({ enabledAdapters }) as MinderConfig;

describe("enabledSources", () => {
  it("defaults to Claude when nothing is configured", () => {
    expect(enabledSources(cfg(), false)).toEqual(["claude"]);
  });

  it("returns the configured adapters", () => {
    expect(enabledSources(cfg(["claude", "codex"]), false)).toEqual(["claude", "codex"]);
  });

  it("adds Claude in demo mode, whose fixtures are all Claude sessions", () => {
    expect(enabledSources(cfg(["codex"]), true)).toEqual(["codex", "claude"]);
    expect(enabledSources(cfg(["claude"]), true)).toEqual(["claude"]);
  });

  it("returns a copy the caller can change", () => {
    const config = cfg(["claude"]);
    enabledSources(config, false).push("x");
    expect(config.enabledAdapters).toEqual(["claude"]);
  });
});
