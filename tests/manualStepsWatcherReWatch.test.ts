import { describe, it, expect, vi, beforeEach } from "vitest";

// ManualStepsWatcher.scanForFiles() reads devRoots via config, lists dirs,
// and watches MANUAL_STEPS.md via fs.watch on the parent directory (B3).
// This suite exercises the B2 fix: after the underlying watcher emits
// 'error' (e.g. the file/dir was removed), the slug must be evicted from
// `watched` so the next poll can re-discover and re-watch it.
vi.mock("fs", () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn(),
    access: vi.fn(),
  },
  watch: vi.fn(),
}));
vi.mock("@/lib/cache", () => ({ invalidateCache: vi.fn() }));
vi.mock("@/lib/config", () => ({
  readConfig: vi.fn().mockResolvedValue({}),
  getDevRoots: vi.fn().mockReturnValue(["C:\\dev"]),
}));

import { promises as fsp, watch } from "fs";
import { ManualStepsWatcher } from "@/lib/manualStepsWatcher";

const mockReaddir = vi.mocked(fsp.readdir);
const mockReadFile = vi.mocked(fsp.readFile);
const mockAccess = vi.mocked(fsp.access);
const mockWatch = vi.mocked(watch);

interface FakeWatcherHandle {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _error?: () => void;
}

function makeWatcherHandle(): FakeWatcherHandle {
  const handle: FakeWatcherHandle = {
    close: vi.fn(),
    on: vi.fn(),
  };
  handle.on.mockImplementation((event: string, cb: () => void) => {
    if (event === "error") handle._error = cb;
    return handle;
  });
  return handle;
}

describe("ManualStepsWatcher — re-watches after a deleted-then-recreated file (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evicts the slug on watcher error so the next poll re-establishes the watch", async () => {
    mockReaddir.mockResolvedValue([
      { name: "myapp", isDirectory: () => true },
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(
      "## 2026-01-01 | x | Title\n\n- [ ] Step\n\n---\n"
    );

    let latestHandle: FakeWatcherHandle | undefined;
    mockWatch.mockImplementation((..._args: unknown[]) => {
      latestHandle = makeWatcherHandle();
      return latestHandle as unknown as ReturnType<typeof watch>;
    });

    const watcher = new ManualStepsWatcher();
    // scanForFiles/watched are private in the TS sense only — accessible at
    // runtime, which is exactly what this test needs to drive the class
    // without standing up the full init()/poll-timer machinery.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = watcher as any;

    await w.scanForFiles();

    expect(w.watched.size).toBe(1);
    expect(mockWatch).toHaveBeenCalledTimes(1);
    expect(latestHandle).toBeDefined();

    // Simulate the underlying watcher erroring — e.g. the file/dir was
    // removed out from under it.
    latestHandle!._error!();

    // B2: the slug must be evicted so a later poll can re-discover the file.
    expect(w.watched.size).toBe(0);

    await w.scanForFiles();
    expect(w.watched.size).toBe(1);
    expect(mockWatch).toHaveBeenCalledTimes(2);
  });
});
