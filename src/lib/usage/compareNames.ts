/**
 * Order two labels the way SQLite's default `BINARY` collation does (#522).
 *
 * Every ranking in a usage report breaks ties on a name, and the two backends
 * must break them identically or the same corpus renders in two orders
 * depending on which one answered.
 *
 * ## Why not `localeCompare`
 *
 * It is not TOTAL. Distinct labels can collate equal — composed `é` (U+00E9)
 * against decomposed `e` + U+0301 is the ordinary case — and a comparator that
 * returns 0 for two different strings falls back to arrival order, which is the
 * defect the tie-break exists to remove. It also has nothing to do with how
 * SQLite orders anything.
 *
 * ## Why not `<`
 *
 * JavaScript compares UTF-16 CODE UNITS. SQLite stores UTF-8 and compares
 * BYTES. Those agree across the whole BMP and disagree above it: an astral
 * character (U+10000 and up) is stored as a surrogate pair in the 0xD800–0xDFFF
 * range, so `<` sorts it BELOW a high-BMP character like U+E000, while UTF-8
 * byte order puts it above. A project directory containing an emoji is enough
 * to hit this (Codex P2, PR #524).
 *
 * ## What this does instead
 *
 * Compares CODE POINTS. UTF-8 is designed so that byte-wise ordering and
 * code-point ordering are the same, so walking code points reproduces SQLite's
 * `BINARY` exactly — without encoding anything.
 *
 * Allocation-free: `codePointAt` reads the pair in place rather than building
 * an array per comparison, which matters because this runs inside sorts that
 * the report calls several times per request.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    // Advance by the UNIT count the code point occupied, not by one — stepping
    // one at a time would land inside a surrogate pair and compare its trailing
    // half against a whole character.
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  // One is a prefix of the other: the shorter sorts first, which is also what
  // byte-wise comparison of UTF-8 does.
  const aLeft = i < a.length;
  const bLeft = j < b.length;
  if (aLeft === bLeft) return 0;
  return aLeft ? 1 : -1;
}
