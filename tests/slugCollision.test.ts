import { describe, it, expect } from "vitest";
import { toSlug, rootSlugHint, resolveProjectSlug } from "@/lib/scanner";

const WSL_LIBRARY = "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\printing-press\\library";

describe("rootSlugHint", () => {
  it("takes the basename of a Windows root", () => {
    expect(rootSlugHint("C:\\dev")).toBe("dev");
  });

  it("takes the basename of a UNC/WSL root", () => {
    expect(rootSlugHint(WSL_LIBRARY)).toBe("library");
  });

  it("normalizes characters the same way toSlug does", () => {
    expect(rootSlugHint("\\\\wsl.localhost\\Ubuntu-26.04")).toBe("ubuntu-26-04");
  });

  it("tolerates trailing separators", () => {
    expect(rootSlugHint("C:\\dev\\")).toBe("dev");
    expect(rootSlugHint("/home/josh/dev/")).toBe("dev");
  });

  it("accepts forward slashes", () => {
    expect(rootSlugHint("//wsl.localhost/Ubuntu-26.04/home/josh/dev")).toBe("dev");
  });

  // A bare drive would yield the hint "c", which disambiguates nothing useful.
  it("returns empty for a drive root", () => {
    expect(rootSlugHint("C:\\")).toBe("");
    expect(rootSlugHint("C:")).toBe("");
  });

  it("returns empty when the basename reduces to no alphanumerics", () => {
    expect(rootSlugHint("C:\\dev\\___")).toBe("");
  });
});

describe("resolveProjectSlug", () => {
  it("returns the plain slug when nothing has claimed it", () => {
    expect(resolveProjectSlug("bamcli", "C:\\dev", new Set())).toBe("bamcli");
  });

  // The regression this whole change exists for: the second checkout used to be
  // dropped from the scan entirely.
  it("suffixes with the root basename on collision", () => {
    const taken = new Set(["bamcli"]);
    expect(resolveProjectSlug("bamcli", WSL_LIBRARY, taken)).toBe("bamcli-library");
  });

  it("is stable across repeated resolution with the same claimed set", () => {
    const taken = new Set(["bamcli"]);
    const first = resolveProjectSlug("bamcli", WSL_LIBRARY, taken);
    const second = resolveProjectSlug("bamcli", WSL_LIBRARY, taken);
    expect(first).toBe(second);
  });

  it("normalizes the directory name before comparing", () => {
    expect(resolveProjectSlug("BamCLI", "C:\\dev", new Set())).toBe("bamcli");
    expect(resolveProjectSlug("BamCLI", WSL_LIBRARY, new Set(["bamcli"]))).toBe("bamcli-library");
  });

  it("falls back to a counter when the suffixed slug is also taken", () => {
    const taken = new Set(["bamcli", "bamcli-library"]);
    expect(resolveProjectSlug("bamcli", WSL_LIBRARY, taken)).toBe("bamcli-library-2");
  });

  it("keeps counting past an occupied numeric tail", () => {
    const taken = new Set(["bamcli", "bamcli-library", "bamcli-library-2", "bamcli-library-3"]);
    expect(resolveProjectSlug("bamcli", WSL_LIBRARY, taken)).toBe("bamcli-library-4");
  });

  it("uses a bare counter when the root offers no hint", () => {
    expect(resolveProjectSlug("bamcli", "C:\\", new Set(["bamcli"]))).toBe("bamcli-2");
  });

  // Avoids the "dev-dev" stutter for a directory named after its own root.
  it("skips the hint when it repeats the directory name", () => {
    expect(resolveProjectSlug("dev", "C:\\dev", new Set(["dev"]))).toBe("dev-2");
  });

  it("handles the intra-root case where two names normalize alike", () => {
    // `bam_cli` and `bam-cli` both slug to `bam-cli`; the second must still get
    // an identity rather than silently overwriting the first. The root hint is
    // applied here too — redundant, since both live in the same root, but
    // unique and stable, which is what the slug actually has to be.
    const taken = new Set<string>();
    const first = resolveProjectSlug("bam_cli", "C:\\dev", taken);
    taken.add(first);
    const second = resolveProjectSlug("bam-cli", "C:\\dev", taken);
    expect(first).toBe("bam-cli");
    expect(second).toBe("bam-cli-dev");
    expect(second).not.toBe(first);
  });

  it("never returns a slug already present in the claimed set", () => {
    const taken = new Set(["bamcli", "bamcli-library", "bamcli-library-2"]);
    for (const root of [WSL_LIBRARY, "C:\\dev", "C:\\"]) {
      expect(taken.has(resolveProjectSlug("bamcli", root, taken))).toBe(false);
    }
  });

  it("produces slugs that are already canonical under toSlug", () => {
    const taken = new Set(["bamcli"]);
    const slug = resolveProjectSlug("bamcli", "\\\\wsl.localhost\\Ubuntu-26.04", taken);
    expect(toSlug(slug)).toBe(slug);
  });
});
