import { promises as fs } from "fs";

/** How much to read per step, walking backwards from the end of the file. */
const CHUNK_BYTES = 256 * 1024;

/**
 * The last `maxLines` non-empty lines of a text file, read backwards from the
 * end in chunks instead of loading the whole file (#690). Session transcripts
 * run to tens of megabytes and the status readers only look at their tail;
 * reading them whole cost ~3 s of UTF-8 decoding per project scan.
 *
 * Returns what `content.split("\n").filter(Boolean).slice(-maxLines)` on the
 * whole file would. Splits on the `\n` byte before decoding, which is safe for
 * UTF-8: 0x0A never occurs inside a multi-byte sequence.
 */
export async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const chunks: Buffer[] = [];
    let start = size;
    let newlines = 0;
    while (start > 0) {
      const len = Math.min(CHUNK_BYTES, start);
      start -= len;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, start);
      // A file truncated since stat() reads short; use only what arrived.
      const chunk = bytesRead === len ? buf : buf.subarray(0, bytesRead);
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) newlines++;
      chunks.unshift(chunk);
      // Enough newlines that the window may hold `maxLines` complete lines
      // after the partial one at its front. Blank lines don't count, so check.
      if (newlines > maxLines) {
        const window = Buffer.concat(chunks);
        const complete = window.subarray(window.indexOf(0x0a) + 1);
        const lines = complete.toString("utf8").split("\n").filter(Boolean);
        if (lines.length >= maxLines) return lines.slice(-maxLines);
      }
    }
    return Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).slice(-maxLines);
  } finally {
    await handle.close();
  }
}
