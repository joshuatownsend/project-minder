import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { writeFileAtomic, renameWithRetry } from "@/lib/atomicWrite";

// Regression coverage for issue #105: writeFileAtomic used a raw fs.rename,
// which intermittently failed on Windows with EPERM when a parallel worker
// churned the filesystem (handle-release lag). It now routes through
// renameWithRetry. These tests drive both the happy path and the retry path
// against real temp dirs, with rename spied to inject transient failures.

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pm-atomicwrite-"));
}

describe("writeFileAtomic", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes content that round-trips", async () => {
    const dir = await mkTmpDir();
    const file = path.join(dir, "out.txt");
    try {
      await writeFileAtomic(file, "hello world");
      expect(await fs.readFile(file, "utf-8")).toBe("hello world");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes Buffer payloads as raw bytes (no transcoding)", async () => {
    const dir = await mkTmpDir();
    const file = path.join(dir, "blob.bin");
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    try {
      await writeFileAtomic(file, bytes);
      const read = await fs.readFile(file);
      expect(read.equals(bytes)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retries a transient EPERM on rename and eventually succeeds (#105)", async () => {
    const dir = await mkTmpDir();
    const file = path.join(dir, "out.txt");
    const realRename = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation((from, to) => {
      calls++;
      if (calls === 1) {
        const err = new Error(
          "EPERM: operation not permitted, rename",
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        return Promise.reject(err);
      }
      return realRename(from as string, to as string);
    });

    await writeFileAtomic(file, "retried content");

    expect(calls).toBe(2); // failed once, succeeded on the retry
    expect(await fs.readFile(file, "utf-8")).toBe("retried content");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does NOT retry a non-transient error and cleans up the tmp file", async () => {
    const dir = await mkTmpDir();
    const file = path.join(dir, "out.txt");
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation(() => {
      calls++;
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT"; // not in the retry set
      return Promise.reject(err);
    });

    await expect(writeFileAtomic(file, "doomed")).rejects.toThrow();
    expect(calls).toBe(1); // ENOENT throws immediately, no backoff loop

    vi.restoreAllMocks();
    // The catch block best-effort unlinks the tmp file; the target was never created.
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp."));
    expect(leftovers).toHaveLength(0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("renameWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives up after `attempts` retries on a persistent transient error", async () => {
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation(() => {
      calls++;
      const err = new Error("EBUSY") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      return Promise.reject(err);
    });

    await expect(renameWithRetry("a", "b", 3)).rejects.toThrow();
    expect(calls).toBe(3);
  });
});
