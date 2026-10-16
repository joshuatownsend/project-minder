import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

// Routes must reach the index through the data façade's process-wide init
// (`ensureSchemaReady` / `probeInitStatus` from `@/lib/data`), never `initDb()`
// directly. A direct call is a second init, and whenever the clean-shutdown
// marker is stale it re-runs `PRAGMA quick_check`, a synchronous scan of the
// whole index that freezes the server (#693, #694).

const APP_DIR = path.join(__dirname, "..", "src", "app");
const IMPORTS_INIT_DB = /import\s*\{[^}]*\binitDb\b[^}]*\}\s*from\s*["']@\/lib\/db\/migrations["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe("routes and pages never call initDb() directly", () => {
  it("no file under src/app imports initDb from @/lib/db/migrations", () => {
    const offenders = sourceFiles(APP_DIR)
      .filter((f) => IMPORTS_INIT_DB.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(APP_DIR, f));
    expect(offenders).toEqual([]);
  });

  it("the pattern catches the import it is meant to catch", () => {
    expect(IMPORTS_INIT_DB.test('import { initDb, type InitResult } from "@/lib/db/migrations";')).toBe(true);
    expect(IMPORTS_INIT_DB.test('import { ensureSchemaReady } from "@/lib/data";')).toBe(false);
  });
});
