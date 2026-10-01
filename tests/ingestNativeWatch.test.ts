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
});
