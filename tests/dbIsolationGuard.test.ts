import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Meta-test: enforces the DB isolation convention across the whole suite
// (issue #331).
//
// WHY A META-TEST AND NOT JUST A HELPER
//
// `tests/_helpers/isolatedState.ts` makes the right thing easy; it cannot make
// the wrong thing fail. The wrong thing here is silent by construction — a
// static import freezes `DB_DIR` to the developer's real `~/.minder` before any
// spy exists, the DB layer is built to degrade quietly rather than throw, and
// the test then passes while reading and writing real data. Thirty files got
// this right by copy-paste; the thirty-first only has to forget one line.
//
// WHY THE RULE IS DERIVED RATHER THAN LISTED
//
// The first draft of this file carried a hand-written list of "modules that
// capture a path". It passed, and it was wrong: `tests/gradeSnapshot.test.ts`
// statically imports `@/lib/data/gradeSnapshots`, whose own line 4 is
// `import { getDb, prepCached } from "@/lib/db/connection"`. One hop away and
// the list missed it. A list of the modules that matter is exactly the thing
// that goes stale, so this walks the static import graph instead and asks the
// question directly: from what this test file imports, can execution reach a
// module that resolves a `~/.minder` path at module scope?
//
// A `vi.mock()`ed specifier is a CUT VERTEX in that graph. The real module is
// replaced before it loads, so nothing beneath it on that path can capture
// anything — which is why the ten API-route tests that import a route handler
// (and mock `@/lib/data` underneath it) are not violations, and are not
// allowlisted either. They already sever the path; the guard can see that.
//
// `import type` is not a violation: type imports are erased before runtime.

const TESTS_DIR = path.resolve(__dirname);
const SRC_DIR = path.resolve(__dirname, "..", "src");

/**
 * Files allowed an unsevered static path to one of those modules, each with the
 * reason its binding to the real home is safe. Adding an entry should require
 * the same argument: say why this file cannot open, create, or write the
 * developer's real database.
 *
 * Keep this list short. An entry is a standing exception to a rule that exists
 * because the failure it prevents is invisible.
 */
const ALLOWLIST = new Map<string, string>([
  [
    "sqlSchemaSnapshot.test.ts",
    // Imports DB_PATH deliberately, and the import IS the fix: recomputing the
    // path pinned the check to the real home regardless of isolation, which is
    // how it came to read another test file's half-built database (#330).
    // Every open is `{ readonly: true }` behind a `migratedDbPresent()` guard.
    "reads DB_PATH read-only by design — see the file's own note on #330",
  ],
  [
    "tasksDbConnectionRace.test.ts",
    // `vi.mock("fs")` replaces the module with a single gated `promises.mkdir`,
    // so the code under test cannot reach a real path even if it tried; the
    // test's whole point is asserting better-sqlite3 is never invoked. Not
    // detected as a cut vertex because the severed edge is `fs`, a bare
    // specifier the graph walk (which only follows `@/`) does not model.
    "mocks `fs` wholesale, so no real path is reachable",
  ],
  [
    "thinkingContent.test.ts",
    // Builds its own `new Database(":memory:")` from `schema.sql` and passes
    // that handle in as the first argument to every call. The module's
    // `getDb()` is never consulted, so the frozen constant is never read.
    "constructs a :memory: DB and injects the handle; getDb() is never called",
  ],
  [
    "sessionsInWindow.test.ts",
    // Same shape as thinkingContent: `loadSessionCostsInWindow(db, …)` takes
    // the handle explicitly.
    "constructs a :memory: DB and injects the handle; getDb() is never called",
  ],
  [
    "rscHydration.test.ts",
    // Calls each `prefetchX` with a stub queryClient whose `prefetchQuery`
    // records `queryKey` and never invokes `queryFn` — the point of the suite
    // is key parity with the client hooks, so no data function ever runs.
    "drives prefetch fns through a stub queryClient that never runs queryFn",
  ],
  [
    "hooksRoute.test.ts",
    // Reaches connection only via route -> notifications/rules/engine ->
    // push/sender. `evaluateAndDispatchRules` returns at
    // `if (!rules?.length) return;` because the file mocks `@/lib/config` with
    // a stub carrying no `notificationRules`, so `sendPushAll` is never
    // reached. Verified against the engine's code path, not just against the
    // absence of a failure.
    "the rules engine returns before push/sender: mocked config has no rules",
  ],
  [
    "mcpBoardTools.test.ts",
    // Reaches connection through mcp/server -> mcp/tools/usage -> data. The
    // suite only invokes the four board tools, whose whole I/O surface is
    // `fs.readFile`/`writeFile`/`rename` on BOARD.md — and `fs` is mocked
    // wholesale, as is `@/lib/tasks/store`. No usage tool is called, so no
    // query reaches getDb().
    "mocks `fs` and tasks/store; exercises only the board tools, never a usage query",
  ],
  [
    "tasksDispatcher.test.ts",
    // dispatcher.ts imports connection directly, but every collaborator the
    // tests drive it through — tasks/store, spawner, the two delegations —
    // is mocked, and `fs` is mocked wholesale on top of that.
    "mocks `fs` plus every store/spawner collaborator; nothing reaches getDb()",
  ],
]);

// ---------------------------------------------------------------------------
// Static import graph over `src/`
// ---------------------------------------------------------------------------
//
// The graph is keyed on RESOLVED FILE PATHS, not on specifier strings, because
// the same module is reached by different spellings depending on where you
// stand: a test says `@/lib/db/migrations`, and that file says `./connection`.
// An earlier draft followed only `@/` specifiers and was blind to the 670
// relative imports in `src/` — so a test importing `@/lib/db/migrations`, one
// of the most direct routes to the database, walked one hop and reported
// clean. Caught by mutation-testing this guard, not by review.

/** Resolve a specifier against the importing file. Null for bare specifiers. */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC_DIR, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else return null; // node builtin or package — not ours to walk
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The two modules that resolve a `~/.minder` path into a module-scope `const`
 * — `DB_DIR`/`DB_PATH` and `TASKS_DB_DIR`/`TASKS_DB_PATH`. Everything else
 * reaches them through the graph, which is what the walk works out.
 */
const TARGET_FILES = new Set(
  [
    path.join(SRC_DIR, "lib", "db", "connection.ts"),
    path.join(SRC_DIR, "lib", "tasksDb", "connection.ts"),
  ].map((p) => path.resolve(p))
);

// Value-level `import … from "…"` / `export … from "…"`, line-anchored.
// `import type` / `export type` are excluded — they evaluate nothing at runtime.
const EDGE = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm;

const edgeCache = new Map<string, string[]>();
function edgesFrom(file: string): string[] {
  const cached = edgeCache.get(file);
  if (cached) return cached;
  const out: string[] = [];
  for (const match of fs.readFileSync(file, "utf8").matchAll(EDGE)) {
    const resolved = resolveSpec(match[1], file);
    if (resolved) out.push(resolved);
  }
  edgeCache.set(file, out);
  return out;
}

const rel = (file: string): string =>
  path.relative(path.resolve(SRC_DIR, ".."), file).split(path.sep).join("/");

/**
 * A path from `file` to a path-capturing module that no mocked module cuts, or
 * null. Returned as the chain of files so a failure names the hops rather than
 * just the endpoints — the whole difficulty of this class of bug is that the
 * link is two or three modules away and invisible at the call site.
 */
function unseveredPathFrom(
  file: string,
  cut: ReadonlySet<string>,
  seen = new Set<string>()
): string[] | null {
  if (cut.has(file)) return null;
  if (TARGET_FILES.has(file)) return [rel(file)];
  if (seen.has(file)) return null;
  seen.add(file);
  for (const next of edgesFrom(file)) {
    const rest = unseveredPathFrom(next, cut, seen);
    if (rest) return [rel(file), ...rest];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test-file inventory
// ---------------------------------------------------------------------------

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const STATIC_IMPORT = /^\s*import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm;
const MOCK_CALL = /vi\.mock\(\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+)["']\s*\)/g;

const resolveFrom = (specs: Iterable<string>, from: string): string[] =>
  [...specs].map((s) => resolveSpec(s, from)).filter((f): f is string => f !== null);

const files = listTestFiles(TESTS_DIR).map((full) => {
  const source = fs.readFileSync(full, "utf8");
  return {
    name: path.relative(TESTS_DIR, full).split(path.sep).join("/"),
    base: path.basename(full),
    source,
    staticImports: resolveFrom(
      new Set([...source.matchAll(STATIC_IMPORT)].map((m) => m[1])),
      full
    ),
    dynamicImports: resolveFrom(
      new Set([...source.matchAll(DYNAMIC_IMPORT)].map((m) => m[1])),
      full
    ),
    // Mocks are cut vertices. Resolved to files so `vi.mock("@/lib/data")`
    // severs the same node the graph walk reaches as `../data` from
    // elsewhere. Bare specifiers (`fs`, `server-only`) resolve to nothing and
    // simply do not participate — see the tasksDbConnectionRace allowlist note.
    mocked: new Set(
      resolveFrom(new Set([...source.matchAll(MOCK_CALL)].map((m) => m[1])), full)
    ),
  };
});

/** Violating chains for one file, empty when it is clean. */
function staticViolations(file: (typeof files)[number]): string[][] {
  const out: string[][] = [];
  for (const imported of file.staticImports) {
    const chain = unseveredPathFrom(imported, file.mocked);
    if (chain) out.push(chain);
  }
  return out;
}

/**
 * Dynamic-import chains in a file that never resets the module registry. A
 * dynamic import only isolates if the registry was reset first; otherwise it
 * hands back the cached instance whose constant was captured on first load —
 * the same frozen path, arrived at by a route that looks correct.
 */
function dynamicViolations(file: (typeof files)[number]): string[][] {
  const resets =
    /vi\.resetModules\(\)/.test(file.source) ||
    /installIsolatedState\(/.test(file.source) ||
    /installMcpIsolation\(/.test(file.source);
  if (resets) return [];
  const out: string[][] = [];
  for (const imported of file.dynamicImports) {
    const chain = unseveredPathFrom(imported, file.mocked);
    if (chain) out.push(chain);
  }
  return out;
}

describe("database isolation convention", () => {
  it("resolves the graph it is about to walk", () => {
    // Guards the walker itself. A broken alias resolution or a glob that
    // matched nothing would make every check below vacuously green — the
    // classic way a meta-test quietly stops meaning anything.
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.base === "dbMigrations.test.ts")).toBe(true);

    const here = path.join(TESTS_DIR, "dbIsolationGuard.test.ts");
    const data = resolveSpec("@/lib/data", here);
    const migrations = resolveSpec("@/lib/db/migrations", here);
    expect(data).not.toBeNull();
    expect(migrations).not.toBeNull();

    // Two known chains, so a walker that stops following edges fails here
    // rather than going quiet. The second is the one that matters: migrations
    // reaches the connection module through a RELATIVE `./connection`, and an
    // alias-only walk missed it entirely.
    expect(unseveredPathFrom(data!, new Set())).toEqual([
      "src/lib/data/index.ts",
      "src/lib/db/connection.ts",
    ]);
    expect(unseveredPathFrom(migrations!, new Set())).toEqual([
      "src/lib/db/migrations.ts",
      "src/lib/db/connection.ts",
    ]);
    // And a mock on the first hop severs it.
    expect(unseveredPathFrom(data!, new Set([data!]))).toBeNull();
  });

  it("no test reaches a DB path constant through an unsevered static import", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file.base)) continue;
      for (const chain of staticViolations(file)) {
        violations.push(
          `${file.name}: static import chain ${chain.join(" -> ")} — the path ` +
            `constant is frozen to the real ~/.minder before any isolation ` +
            `runs. Use installIsolatedState() from ` +
            `tests/_helpers/isolatedState.ts and import dynamically after ` +
            `reload(), vi.mock() a module on the chain, or add the file to ` +
            `ALLOWLIST with a reason.`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("no test dynamically imports one without resetting the module registry", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file.base)) continue;
      for (const chain of dynamicViolations(file)) {
        violations.push(
          `${file.name}: dynamic import chain ${chain.join(" -> ")} with no ` +
            `module-registry reset — call installIsolatedState() and await ` +
            `state.reload() before importing.`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    // An allowlist entry for a file that no longer violates anything is a
    // standing exception nobody re-examines. Fail so it gets deleted.
    const stale: string[] = [];
    for (const [base] of ALLOWLIST) {
      const file = files.find((f) => f.base === base);
      if (!file) {
        stale.push(`${base} is allowlisted but no such test file exists`);
        continue;
      }
      if (staticViolations(file).length + dynamicViolations(file).length === 0) {
        stale.push(`${base} is allowlisted but no longer needs to be`);
      }
    }
    expect(stale).toEqual([]);
  });
});
