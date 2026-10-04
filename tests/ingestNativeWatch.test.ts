import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { startNativeRecursiveWatch, type NativeWatch } from "@/lib/db/nativeWatch";

// #595 — the single recursive watch that replaces chokidar's per-file watches.
// Real filesystem, real events: the point of the module is what the OS delivers,
// and a mocked fs.watch would only prove the mapping, not that nested files in
// directories created AFTER the watch started are seen at all.

let root: string;
let watch: NativeWatch | null = null;

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  watch?.close();
  watch = null;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-native-watch-"));
  const changed = new Set<string>();
  const gone = new Set<string>();
  const errors: Error[] = [];
  watch = startNativeRecursiveWatch(root, {
    onChange: (p) => changed.add(p),
    onGone: (p) => gone.add(p),
    onError: (e) => errors.push(e),
  });
  return { changed, gone, errors };
}

describe("startNativeRecursiveWatch", () => {
  it("sees a transcript created in a project dir that did not exist when the watch started", async () => {
    const { changed } = await setup();
    expect(watch).not.toBeNull();
    const file = path.join(root, "C--dev-new", "s1.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}\n");
    await waitFor(() => changed.has(file));
  });

  it("sees an append to a nested subagent transcript, as an absolute path under the root", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-native-pre-"));
    const nested = path.join(root, "C--dev-a", "sess", "subagents");
    await fs.mkdir(nested, { recursive: true });
    const file = path.join(nested, "agent-1.jsonl");
    await fs.writeFile(file, "{}\n");
    const changed = new Set<string>();
    watch = startNativeRecursiveWatch(root, { onChange: (p) => changed.add(p), onGone: () => {}, onError: () => {} });
    await fs.appendFile(file, "{}\n");
    await waitFor(() => changed.has(file));
  });

  it("reports a deleted transcript as gone, not changed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-native-del-"));
    const file = path.join(root, "p", "s.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}\n");
    const changed = new Set<string>();
    const gone = new Set<string>();
    watch = startNativeRecursiveWatch(root, {
      onChange: (p) => changed.add(p),
      onGone: (p) => gone.add(p),
      onError: () => {},
    });
    await fs.rm(file);
    await waitFor(() => gone.has(file));
    expect(changed.has(file)).toBe(false);
  });

  it("ignores files that are not transcripts", async () => {
    const { changed, gone } = await setup();
    const txt = path.join(root, "notes.txt");
    const jsonl = path.join(root, "real.jsonl");
    await fs.writeFile(txt, "x");
    await fs.writeFile(jsonl, "{}\n");
    await waitFor(() => changed.has(jsonl));
    expect(changed.has(txt)).toBe(false);
    expect(gone.size).toBe(0);
  });

  it("returns null instead of throwing when the root does not exist", () => {
    expect(
      startNativeRecursiveWatch(path.join(os.tmpdir(), "pm-native-missing-" + Date.now()), {
        onChange: () => {},
        onGone: () => {},
        onError: () => {},
      })
    ).toBeNull();
  });

  // #604 — an access-time bump is delivered as `change`. On this class of volume
  // one full read of the corpus used to queue a no-op reconcile per file.
  describe("access-time events (#604)", () => {
    const HOUR = 3_600_000;

    /** A transcript last WRITTEN an hour ago, with a watch already running. */
    async function oldTranscriptWatched() {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "pm-native-atime-"));
      const old = path.join(root, "p", "old.jsonl");
      const marker = path.join(root, "p", "marker.jsonl");
      await fs.mkdir(path.dirname(old), { recursive: true });
      await fs.writeFile(old, "{}\n");
      await fs.writeFile(marker, "{}\n");
      const past = new Date(Date.now() - HOUR);
      await fs.utimes(old, past, past);
      const changed: string[] = [];
      watch = startNativeRecursiveWatch(root, {
        onChange: (p) => changed.push(p),
        onGone: () => {},
        onError: () => {},
      });
      await new Promise((r) => setTimeout(r, 300)); // let the OS watch settle
      /** Events arrive in order, so once the marker's write is seen, anything earlier already was. */
      const flush = async () => {
        const before = changed.filter((p) => p === marker).length;
        await fs.appendFile(marker, "{}\n");
        await waitFor(() => changed.filter((p) => p === marker).length > before);
      };
      return { old, marker, changed, flush };
    }

    it("does not forward an access-time-only update of a transcript nobody wrote", async () => {
      const { old, changed, flush } = await oldTranscriptWatched();
      const st = await fs.stat(old);
      await fs.utimes(old, new Date(), st.mtime); // atime now, mtime untouched
      await flush();
      expect(changed).not.toContain(old);
    });

    it("does not forward a plain read of an old transcript", async () => {
      const { old, changed, flush } = await oldTranscriptWatched();
      const st = await fs.stat(old);
      await fs.utimes(old, new Date(Date.now() - 2 * HOUR), st.mtime); // age atime so the read bumps it
      await new Promise((r) => setTimeout(r, 200));
      await fs.readFile(old);
      await flush();
      expect(changed).not.toContain(old);
    });

    it("still forwards a genuine append to an old transcript", async () => {
      const { old, changed } = await oldTranscriptWatched();
      await fs.appendFile(old, "{}\n");
      await waitFor(() => changed.includes(old));
    });

    it("does not re-forward a read that follows a write it already forwarded", async () => {
      const { old, changed, flush } = await oldTranscriptWatched();
      await fs.appendFile(old, "{}\n");
      await waitFor(() => changed.includes(old));
      // One append can be reported twice (the write, then the close with the mtime
      // updated), and both are legitimately forwarded; let that settle before
      // taking the baseline so only the READ is under test.
      await new Promise((r) => setTimeout(r, 500));
      const forwarded = changed.filter((p) => p === old).length;

      const st = await fs.stat(old);
      // Age the atime and leave mtime/size alone. NOT `st.mtime`: Node builds that Date
      // by ROUNDING, so passing it back shifts the mtime by up to 1 ms and the
      // file would look written again. A real read never touches mtime at all.
      await fs.utimes(old, new Date(Date.now() - 2 * HOUR), Math.floor(st.mtimeMs) / 1000);
      await new Promise((r) => setTimeout(r, 200));
      await fs.readFile(old);
      await flush();
      expect(changed.filter((p) => p === old).length).toBe(forwarded);
    });

    it("forwards a second real write even though the first was remembered", async () => {
      const { old, changed } = await oldTranscriptWatched();
      await fs.appendFile(old, "{}\n");
      await waitFor(() => changed.filter((p) => p === old).length >= 1);
      const first = changed.filter((p) => p === old).length;
      await fs.appendFile(old, '{"more":true}\n');
      await waitFor(() => changed.filter((p) => p === old).length > first);
    });
  });
});

