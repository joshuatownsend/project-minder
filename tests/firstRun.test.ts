import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `isFirstRun` asks two questions: does `.minder.json` exist (fs.access), and
// does any candidate dev root exist (probeDefaultDevRoot). Mock both seams.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    promises: { ...actual.promises, access: vi.fn() },
  };
});

vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, probeDefaultDevRoot: vi.fn() };
});

const { promises: fsp } = await import("fs");
const { probeDefaultDevRoot } = await import("@/lib/platform");
const { isFirstRun } = await import("@/lib/config");

const access = vi.mocked(fsp.access);
const probe = vi.mocked(probeDefaultDevRoot);

/**
 * `fs.access` rejects with an errno-tagged Error, and `isFirstRun` branches on
 * `.code` — NOT the message. Building the real shape here is what makes the
 * "unreadable config is not first-run" tests below meaningful; a bare
 * `new Error("ENOENT")` carries no code and would exercise the wrong branch.
 */
function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  err.code = code;
  return err;
}

describe("isFirstRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is true when there is no config file AND no candidate root exists", async () => {
    access.mockRejectedValue(errno("ENOENT"));
    probe.mockReturnValue(null);
    expect(await isFirstRun()).toBe(true);
  });

  it("is false when a candidate root exists — nothing to ask, just scan it", async () => {
    access.mockRejectedValue(errno("ENOENT"));
    probe.mockReturnValue("C:\\dev");
    expect(await isFirstRun()).toBe(false);
  });

  // A non-directory parent component means the file cannot exist at that path,
  // so it is genuinely absent rather than merely unreachable.
  it("treats ENOTDIR as an absent config", async () => {
    access.mockRejectedValue(errno("ENOTDIR"));
    probe.mockReturnValue(null);
    expect(await isFirstRun()).toBe(true);
  });

  // PR #316 review: any errno OTHER than "absent" most likely means a config
  // DOES exist but couldn't be reached this instant. Treating that as first-run
  // would hijack a long-time user's dashboard over a transient blip — and
  // FirstRunSetup's save would then overwrite the config they still have.
  it.each(["EACCES", "EPERM", "EIO", "EBUSY", "EMFILE"])(
    "is false when the config is unreadable with %s, even with no candidate root",
    async (code) => {
      access.mockRejectedValue(errno(code));
      probe.mockReturnValue(null);
      expect(await isFirstRun()).toBe(false);
    }
  );

  // An error with no `.code` at all is equally "not proof of absence".
  it("is false when access rejects with an untagged error", async () => {
    access.mockRejectedValue(new Error("something odd"));
    probe.mockReturnValue(null);
    expect(await isFirstRun()).toBe(false);
  });

  it("does not probe the filesystem when the config is merely unreadable", async () => {
    access.mockRejectedValue(errno("EACCES"));
    probe.mockReturnValue(null);
    await isFirstRun();
    expect(probe).not.toHaveBeenCalled();
  });

  // The regression that matters most: someone who completed setup must never
  // be dropped back into it, even if their configured root is unreachable
  // right now (unplugged drive, stopped WSL distro).
  it("is false when a config file exists, even with no candidate root", async () => {
    access.mockResolvedValue(undefined);
    probe.mockReturnValue(null);
    expect(await isFirstRun()).toBe(false);
  });

  it("does not even probe the filesystem when a config file exists", async () => {
    access.mockResolvedValue(undefined);
    probe.mockReturnValue(null);
    await isFirstRun();
    expect(probe).not.toHaveBeenCalled();
  });
});
