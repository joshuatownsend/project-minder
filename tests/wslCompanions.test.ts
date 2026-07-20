import { describe, it, expect } from "vitest";
import {
  deriveWslCompanions,
  mergeWslCompanions,
  findUnmappedWslRoots,
} from "@/lib/wslCompanions";
import { mapLocalPath } from "@/lib/pathMapping";
import { encodePath } from "@/lib/scanner/claudeConversations";

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

describe("findUnmappedWslRoots", () => {
  it("reports a WSL root with no companions at all", () => {
    expect(findUnmappedWslRoots({ devRoots: ["C:\\dev", `${HOME}\\dev`] })).toEqual([
      `${HOME}\\dev`,
    ]);
  });

  it("reports a root that has a mapping but no Claude home", () => {
    expect(
      findUnmappedWslRoots({
        devRoots: [`${HOME}\\dev`],
        pathMappings: [{ from: "/home/josh", to: HOME }],
      })
    ).toEqual([`${HOME}\\dev`]);
  });

  it("reports a root that has a Claude home but no mapping", () => {
    expect(
      findUnmappedWslRoots({
        devRoots: [`${HOME}\\dev`],
        claudeHomes: [`${HOME}\\.claude`],
      })
    ).toEqual([`${HOME}\\dev`]);
  });

  it("reports nothing once both are present", () => {
    expect(
      findUnmappedWslRoots({
        devRoots: [`${HOME}\\dev`],
        claudeHomes: [`${HOME}\\.claude`],
        pathMappings: [{ from: "/home/josh", to: HOME }],
      })
    ).toEqual([]);
  });

  it("never reports non-WSL roots", () => {
    expect(findUnmappedWslRoots({ devRoots: ["C:\\dev", "D:\\work"] })).toEqual([]);
  });

  it("does not require a Claude home for a root outside /home", () => {
    expect(
      findUnmappedWslRoots({
        devRoots: [`${DISTRO}\\opt\\src`],
        pathMappings: [{ from: "/opt", to: `${DISTRO}\\opt` }],
      })
    ).toEqual([]);
  });

  it("falls back to the legacy single devRoot", () => {
    expect(findUnmappedWslRoots({ devRoot: `${HOME}\\dev` })).toEqual([`${HOME}\\dev`]);
  });

  it("is satisfied by whatever mergeWslCompanions produces", () => {
    const roots = ["C:\\dev", `${HOME}\\dev`, `${DISTRO}\\opt\\src`];
    expect(findUnmappedWslRoots({ devRoots: roots, ...mergeWslCompanions(roots) })).toEqual([]);
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

  it("one home mapping serves roots at different depths", () => {
    // The reason mappings cut at the home: a single entry derived from the
    // shallow root still resolves a project under the deep one.
    const { pathMappings } = mergeWslCompanions([`${HOME}\\dev`]);
    expect(
      encodePath(mapLocalPath(`${HOME}\\printing-press\\library\\bamcli`, pathMappings))
    ).toBe("-home-josh-printing-press-library-bamcli");
  });
});
