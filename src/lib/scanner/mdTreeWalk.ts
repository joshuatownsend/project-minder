import { promises as fs } from "fs";
import path from "path";

const DEFAULT_MAX_DEPTH = 4;

export interface MdTreeFile {
  file: string;
  lines: number;
  bytes: number;
}

/**
 * Recursively list `.md` files under `dir`, returning size and line counts.
 * Reads each file once — callers that only need paths still pay the read,
 * but in practice the only callers (audit + budget) need both.
 */
export async function walkMdTree(
  dir: string,
  opts: { maxDepth?: number } = {}
): Promise<MdTreeFile[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const out: MdTreeFile[] = [];

  async function walk(d: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith(".")) return;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          await walk(full, depth + 1);
          return;
        }
        if (!e.name.toLowerCase().endsWith(".md")) return;
        try {
          const raw = await fs.readFile(full, "utf-8");
          out.push({
            file: full,
            lines: raw.split(/\r?\n/).length,
            bytes: Buffer.byteLength(raw, "utf-8"),
          });
        } catch {
          // unreadable file — skip
        }
      })
    );
  }

  await walk(dir, 0);
  return out;
}
