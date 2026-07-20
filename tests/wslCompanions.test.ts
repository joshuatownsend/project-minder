import { describe, it, expect } from "vitest";
import {
  deriveWslCompanions,
  mergeWslCompanions,
  analyzeWslRoots,
} from "@/lib/wslCompanions";
import { parseWslUncPath } from "@/lib/wsl";
import { mapLocalPath } from "@/lib/pathMapping";
import { encodePath, toSlug as usageToSlug } from "@/lib/scanner/claudeConversations";
import { canonicalizeDirName } from "@/lib/usage/parser";

const DISTRO = "\\\\wsl.localhost\\Ubuntu-26.04";
const HOME = `${DISTRO}\\home\\josh`;

describe("deriveWslCompanions", () => {
  it("returns null for a non-WSL path", () => {
    expect(deriveWslCompanions("C:\\dev")).toBeNull();
    expect(deriveWslCompanions("/home/josh/dev")).toBeNull();
  });

  it("returns null for a bare distro root", () => {
    // Would imply a "/" prefix, which the mapping layer discards as empty.
    expect(deriveWslCompanions(DISTRO)).toBeNull();
    expect(deriveWslCompanions(`${DISTRO}\\`)).toBeNull();
  });

  it("cuts the mapping at the user home, not the scan root", () => {
    // One entry has to cover repos nested well below the root — this is the
    // whole reason a deeply-nested root still works.
    const c = deriveWslCompanions(`${HOME}\\printing-press\\library`);
    expect(c?.pathMapping).toEqual({ from: "/home/josh", to: HOME });
  });

  it("derives the same mapping regardless of depth under the home", () => {
    const shallow = deriveWslCompanions(`${HOME}\\dev`);
    const deep = deriveWslCompanions(`${HOME}\\printing-press\\library\\nested`);
    expect(shallow?.pathMapping).toEqual(deep?.pathMapping);
  });

  it("derives the distro user's Claude home", () => {
    expect(deriveWslCompanions(`${HOME}\\dev`)?.claudeHome).toBe(`${HOME}\\.claude`);
  });

  it("accepts forward slashes", () => {
    const c = deriveWslCompanions("//wsl.localhost/Ubuntu-26.04/home/josh/dev");
    expect(c?.pathMapping).toEqual({ from: "/home/josh", to: HOME });
  });

  it("tolerates trailing separators and surrounding whitespace", () => {
    const c = deriveWslCompanions(`  ${HOME}\\dev\\  `);
    expect(c?.pathMapping.from).toBe("/home/josh");
  });

  // mapForeignPath concatenates `to` verbatim, so emitting a different host
  // alias than the scan root uses would produce paths no project matches.
  it("preserves the legacy wsl$ alias when the root uses it", () => {
    const c = deriveWslCompanions("\\\\wsl$\\Ubuntu-26.04\\home\\josh\\dev");
    expect(c?.pathMapping.to).toBe("\\\\wsl$\\Ubuntu-26.04\\home\\josh");
    expect(c?.claudeHome).toBe("\\\\wsl$\\Ubuntu-26.04\\home\\josh\\.claude");
  });

  it("handles a distro name containing a space", () => {
    const c = deriveWslCompanions("\\\\wsl.localhost\\My Distro\\home\\josh\\dev");
    expect(c?.pathMapping.to).toBe("\\\\wsl.localhost\\My Distro\\home\\josh");
  });

  it("maps the top-level segment when the root is outside /home", () => {
    const c = deriveWslCompanions(`${DISTRO}\\opt\\src`);
    expect(c?.pathMapping).toEqual({ from: "/opt", to: `${DISTRO}\\opt` });
    expect(c?.claudeHome).toBeNull(); // no user home to infer
  });

  it("treats a bare /home root as top-level (no user to infer)", () => {
    const c = deriveWslCompanions(`${DISTRO}\\home`);
    expect(c?.pathMapping).toEqual({ from: "/home", to: `${DISTRO}\\home` });
    expect(c?.claudeHome).toBeNull();
  });
});

describe("mergeWslCompanions", () => {
  it("adds both settings for a fresh WSL root", () => {
    const merged = mergeWslCompanions([`${HOME}\\dev`], {});
    expect(merged.claudeHomes).toEqual([`${HOME}\\.claude`]);
    expect(merged.pathMappings).toEqual([{ from: "/home/josh", to: HOME }]);
    expect(merged.added).toBe(2);
  });

  it("ignores non-WSL roots", () => {
    const merged = mergeWslCompanions(["C:\\dev"], {});
    expect(merged.added).toBe(0);
    expect(merged.claudeHomes).toEqual([]);
    expect(merged.pathMappings).toEqual([]);
  });

  it("collapses two roots under one home into a single pair", () => {
    const merged = mergeWslCompanions([`${HOME}\\dev`, `${HOME}\\printing-press\\library`], {});
    expect(merged.pathMappings).toHaveLength(1);
    expect(merged.claudeHomes).toHaveLength(1);
  });

  it("keeps separate entries for different users", () => {
    const merged = mergeWslCompanions([`${HOME}\\dev`, `${DISTRO}\\home\\ada\\dev`], {});
    expect(merged.pathMappings.map((m) => m.from)).toEqual(["/home/josh", "/home/ada"]);
    expect(merged.claudeHomes).toHaveLength(2);
  });

  // A hand-tuned mapping is more authoritative than anything path-derivable.
  it("never overwrites an existing mapping for the same prefix", () => {
    const custom = { from: "/home/josh", to: "\\\\wsl.localhost\\Other\\home\\josh" };
    const merged = mergeWslCompanions([`${HOME}\\dev`], { pathMappings: [custom] });
    expect(merged.pathMappings).toEqual([custom]);
  });

  it("treats a same-prefix/different-distro mapping as a conflict, not a merge", () => {
    // Two distros with the same Linux username both derive "/home/josh". A
    // second entry would be dead config — mapForeignPath returns on the first
    // match — so this is reported rather than silently 'fixed'.
    const debian = "\\\\wsl.localhost\\Debian\\home\\josh";
    const merged = mergeWslCompanions([`${HOME}\\dev`, `${debian}\\dev`], {});
    expect(merged.pathMappings).toEqual([{ from: "/home/josh", to: HOME }]);
    expect(merged.conflicts).toEqual([
      { root: `${debian}\\dev`, from: "/home/josh", existingTo: HOME },
    ]);
  });

  it("does not add a Claude home for a conflicted root", () => {
    // Reading a distro's sessions with no usable mapping finds nothing to
    // match them against — it would cost the read and change no outcome.
    const debian = "\\\\wsl.localhost\\Debian\\home\\josh";
    const merged = mergeWslCompanions([`${HOME}\\dev`, `${debian}\\dev`], {});
    expect(merged.claudeHomes).toEqual([`${HOME}\\.claude`]);
  });

  it("reports no conflict when the existing mapping already points here", () => {
    const merged = mergeWslCompanions([`${HOME}\\dev`], {
      pathMappings: [{ from: "/home/josh", to: HOME }],
    });
    expect(merged.conflicts).toEqual([]);
  });

  it("matches an existing mapping written with the other host alias", () => {
    const merged = mergeWslCompanions([`${HOME}\\dev`], {
      pathMappings: [{ from: "/home/josh", to: "\\\\wsl$\\Ubuntu-26.04\\home\\josh" }],
    });
    expect(merged.conflicts).toEqual([]);
    expect(merged.pathMappings).toHaveLength(1);
  });

  it("is idempotent — re-merging adds nothing", () => {
    const first = mergeWslCompanions([`${HOME}\\dev`], {});
    const second = mergeWslCompanions([`${HOME}\\dev`], first);
    expect(second.added).toBe(0);
    expect(second.claudeHomes).toEqual(first.claudeHomes);
    expect(second.pathMappings).toEqual(first.pathMappings);
  });

  it("dedupes an existing home written with the legacy alias", () => {
    const merged = mergeWslCompanions([`${HOME}\\dev`], {
      claudeHomes: ["\\\\wsl$\\Ubuntu-26.04\\home\\josh\\.claude"],
    });
    expect(merged.claudeHomes).toHaveLength(1);
  });

  it("preserves unrelated existing entries", () => {
    const other = { from: "/srv", to: "\\\\wsl.localhost\\Ubuntu-26.04\\srv" };
    const merged = mergeWslCompanions([`${HOME}\\dev`], {
      claudeHomes: ["D:\\claude"],
      pathMappings: [other],
    });
    expect(merged.pathMappings).toContainEqual(other);
    expect(merged.claudeHomes).toContain("D:\\claude");
  });
});

/**
 * End-to-end check of the thing P0 actually exists to fix. The unit tests above
 * assert the shape of the derived settings; this asserts they produce the ONE
 * string that matters — the encoded session-directory name Claude Code wrote
 * inside the distro. If this drifts, every WSL project silently reports zero
 * cost again, which is exactly the failure that went unnoticed until it was
 * measured (97% of one project's sessions were invisible).
 *
 * The expected values are real: they come from
 * `\\wsl.localhost\Ubuntu-26.04\home\josh\.claude\projects\` on the machine
 * where this was diagnosed.
 */
describe("derived mapping resolves a WSL project to its real session directory", () => {
  const cases = [
    {
      root: `${HOME}\\printing-press\\library`,
      project: `${HOME}\\printing-press\\library\\bamcli`,
      encoded: "-home-josh-printing-press-library-bamcli",
    },
    {
      root: `${HOME}\\dev`,
      project: `${HOME}\\dev\\bamcli`,
      encoded: "-home-josh-dev-bamcli",
    },
  ];

  it.each(cases)("$project → $encoded", ({ root, project, encoded }) => {
    const { pathMappings } = mergeWslCompanions([root]);
    expect(encodePath(mapLocalPath(project, pathMappings))).toBe(encoded);
  });

  it("produces the wrong directory without the mapping (the bug)", () => {
    // Guards the guard: if this ever starts matching with NO mappings, the test
    // above would pass for the wrong reason.
    const project = `${HOME}\\printing-press\\library\\bamcli`;
    expect(encodePath(mapLocalPath(project, []))).not.toBe(
      "-home-josh-printing-press-library-bamcli"
    );
  });

  /**
   * The invariant the per-project Sessions tab now relies on (#325): the
   * scanner's `usageSlug` and the session parser's `SessionSummary.projectSlug`
   * are the same string, so a client can filter on equality instead of
   * re-deriving a key from the project path — which cannot see pathMappings and
   * so matched nothing for every WSL project.
   */
  it("usageSlug equals the projectSlug the session parser derives", () => {
    const { pathMappings } = mergeWslCompanions([`${HOME}\\printing-press\\library`]);
    const project = `${HOME}\\printing-press\\library\\bamcli`;

    // What the scanner stamps on ProjectData.
    const usageSlug = usageToSlug(
      canonicalizeDirName(encodePath(mapLocalPath(project, pathMappings)))
    );
    // What the session parser stamps on each SessionSummary, starting from the
    // real on-disk directory name.
    const sessionSlug = usageToSlug(
      canonicalizeDirName("-home-josh-printing-press-library-bamcli")
    );

    expect(usageSlug).toBe(sessionSlug);
    expect(usageSlug).toBe("home-josh-printing-press-library-bamcli");
  });

  it("the old path-derived key would not have matched", () => {
    // The #325 bug in one line: encoding the UNC path in the browser yields a
    // key bearing no resemblance to the distro-recorded directory.
    const project = `${HOME}\\printing-press\\library\\bamcli`;
    const browserDerived = project.replace(/[:\\/]/g, "-");
    expect(browserDerived).not.toBe("-home-josh-printing-press-library-bamcli");
    expect(browserDerived).toContain("wsl.localhost");
  });

  it("one home mapping serves roots at different depths", () => {
    // The reason mappings cut at the home: a single entry derived from the
    // shallow root still resolves a project under the deep one.
    const { pathMappings } = mergeWslCompanions([`${HOME}\\dev`]);
    expect(
      encodePath(mapLocalPath(`${HOME}\\printing-press\\library\\bamcli`, pathMappings))
    ).toBe("-home-josh-printing-press-library-bamcli");
  });
});

describe("analyzeWslRoots", () => {
  const DEBIAN_HOME = "\\\\wsl.localhost\\Debian\\home\\josh";

  it("reports a WSL root with no companions as repairable", () => {
    const r = analyzeWslRoots({ devRoots: ["C:\\dev", `${HOME}\\dev`] });
    expect(r.repairable).toEqual([`${HOME}\\dev`]);
    expect(r.conflicted).toEqual([]);
  });

  it("reports a root that has a mapping but no Claude home", () => {
    expect(
      analyzeWslRoots({
        devRoots: [`${HOME}\\dev`],
        pathMappings: [{ from: "/home/josh", to: HOME }],
      }).repairable
    ).toEqual([`${HOME}\\dev`]);
  });

  it("reports a root that has a Claude home but no mapping", () => {
    expect(
      analyzeWslRoots({
        devRoots: [`${HOME}\\dev`],
        claudeHomes: [`${HOME}\\.claude`],
      }).repairable
    ).toEqual([`${HOME}\\dev`]);
  });

  it("reports nothing once both are present", () => {
    const r = analyzeWslRoots({
      devRoots: [`${HOME}\\dev`],
      claudeHomes: [`${HOME}\\.claude`],
      pathMappings: [{ from: "/home/josh", to: HOME }],
    });
    expect(r.repairable).toEqual([]);
    expect(r.conflicted).toEqual([]);
  });

  // Matching on `from` alone would call this configured while the mapping
  // actually points at a different distro — a repair button that does nothing.
  it("does not consider a root configured by another distro's mapping", () => {
    const r = analyzeWslRoots({
      devRoots: [`${DEBIAN_HOME}\\dev`],
      pathMappings: [{ from: "/home/josh", to: HOME }],
    });
    expect(r.repairable).toEqual([]);
    expect(r.conflicted).toEqual([
      { root: `${DEBIAN_HOME}\\dev`, from: "/home/josh", existingTo: HOME },
    ]);
  });

  it("never reports non-WSL roots", () => {
    expect(analyzeWslRoots({ devRoots: ["C:\\dev", "D:\\work"] }).repairable).toEqual([]);
  });

  it("does not require a Claude home for a root outside /home", () => {
    expect(
      analyzeWslRoots({
        devRoots: [`${DISTRO}\\opt\\src`],
        pathMappings: [{ from: "/opt", to: `${DISTRO}\\opt` }],
      }).repairable
    ).toEqual([]);
  });

  it("falls back to the legacy single devRoot", () => {
    expect(analyzeWslRoots({ devRoot: `${HOME}\\dev` }).repairable).toEqual([`${HOME}\\dev`]);
  });

  it("is satisfied by whatever mergeWslCompanions produces", () => {
    const roots = ["C:\\dev", `${HOME}\\dev`, `${DISTRO}\\opt\\src`];
    const r = analyzeWslRoots({ devRoots: roots, ...mergeWslCompanions(roots) });
    expect(r.repairable).toEqual([]);
    expect(r.conflicted).toEqual([]);
  });
});

/**
 * `wslCompanions` is imported by a "use client" component, so it cannot import
 * `./wsl` (child_process) or `./platform` (fs) — Turbopack fails the build
 * rather than tree-shaking them, and neither typecheck nor the unit suite
 * notices. It therefore keeps local copies of the pure helpers it needs.
 *
 * These tests are the drift guard for that duplication: they run under Node, so
 * they CAN import the originals and assert the copies still agree.
 */
describe("local helper copies stay in sync with their originals", () => {
  const paths = [
    "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\dev",
    "\\\\wsl$\\Ubuntu-26.04\\home\\josh\\dev",
    "//wsl.localhost/Ubuntu-26.04/home/josh/dev",
    "\\\\wsl.localhost\\My Distro\\home\\josh",
    "\\\\wsl.localhost\\Ubuntu-26.04",
    "  \\\\wsl.localhost\\Ubuntu-26.04\\home  ",
    "C:\\dev",
    "/home/josh/dev",
    "",
    "\\\\wsl.localhost\\",
    "\\\\notwsl\\share\\dir",
  ];

  it.each(paths)("agrees with parseWslUncPath on %j", (p) => {
    // A non-null derivation implies the real parser accepts the path too — the
    // reverse isn't required, since derivation additionally needs a segment
    // past the distro.
    const derived = deriveWslCompanions(p);
    if (derived !== null) {
      const parsed = parseWslUncPath(p);
      expect(parsed).not.toBeNull();
      expect(derived.pathMapping.to).toContain(parsed!.distro);
    }
  });

  it("rejects every path the real parser rejects", () => {
    for (const p of paths) {
      if (parseWslUncPath(p) === null) expect(deriveWslCompanions(p)).toBeNull();
    }
  });
});
