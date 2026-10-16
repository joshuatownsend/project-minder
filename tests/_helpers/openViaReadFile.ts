/**
 * An `fs.promises.open` stand-in for tests that mock `fs` with a `readFile`
 * fixture: the handle serves `stat()` and positional `read()` from whatever the
 * mocked `readFile` returns for that path. Lets code that reads files by
 * offset (`jsonlTail`, the incremental history parse) run against the same
 * fixtures as code that reads them whole.
 */
export function openViaReadFile(readFile: (p: string, enc?: string) => Promise<unknown>) {
  return async (p: unknown) => {
    const content = await readFile(String(p), "utf-8");
    const bytes = Buffer.from(String(content), "utf8");
    return {
      stat: async () => ({ size: bytes.length }),
      read: async (buf: Buffer, offset: number, length: number, position: number) => {
        const n = bytes.copy(buf, offset, position, Math.min(position + length, bytes.length));
        return { bytesRead: n, buffer: buf };
      },
      close: async () => {},
    };
  };
}
