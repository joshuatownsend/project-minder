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
 *
 * Keyed by path relative to `tests/`, not by basename. The inventory recurses
 * (`tests/usage/longContextTier.test.ts` already exists), so a future
 * `tests/api/hooksRoute.test.ts` would otherwise inherit the root file's
 * exemption without inheriting a word of its safety argument (Codex review,
 * PR #419).
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
    "engagementExportFilename.test.ts",
    // Arrived on main in #418 while this branch was open, and the guard caught
    // it on the merge — which is the guard working, not a merge problem.
    //
    // The file imports the export route only to reach two pure string helpers
    // it re-exports as `__testing` (`safeFilename`, `trimDashes`); the route
    // then pulls in `@/lib/data`. Every test here passes strings to those two
    // functions, so no query runs.
    //
    // Allowlisted rather than rewritten because the real fix belongs to that
    // module, not to this file: move the helpers somewhere a test can import
    // without dragging a route's dependency graph behind them. Filed in
    // TODO.md.
    "imports a route only for two pure string helpers; no query runs",
  ],
  [
    "bootstrap.test.ts",
    // Imports `@/lib/bootstrap`, which reaches both connection modules through
    // runtime `import()`. Both sit inside `onShutdown(...)` callbacks
    // (bootstrap.ts:231, :235) — registered during boot, executed only when the
    // process shuts down, which this suite never does. It also never calls
    // `initServiceLog()`, guarded behind `!process.env.VITEST` at
    // bootstrap.ts:173, so the `~/.minder/logs` mkdir #331 asked about does not
    // fire either.
    "its runtime DB imports live in onShutdown callbacks the suite never runs",
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

// Value-level `import … from "…"` / `export … from "…"`, line-anchored, plus
// the bindingless `import "…";` side-effect form — which evaluates the module
// and so carries the same freeze. `import type` / `export type` are excluded:
// they evaluate nothing at runtime.
const EDGE = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm;
const EDGE_SIDE_EFFECT = /^\s*import\s+["']([^"']+)["']\s*;/gm;

const edgeCache = new Map<string, string[]>();
function edgesFrom(file: string): string[] {
  const cached = edgeCache.get(file);
  if (cached) return cached;
  const out: string[] = [];
  // Comment-stripped, for the same reason the test inventory is: a module's
  // doc comment can contain a perfectly-formed import. `isolatedState.ts`
  // documents its own usage with `await import("@/lib/db/connection")` in a
  // header comment, which was being read as a real edge — making every one of
  // the 31 files that use the helper appear to reach the connection module
  // through it. Found while measuring a different change (PR #419).
  const src = stripComments(fs.readFileSync(file, "utf8"));
  for (const pattern of [EDGE, EDGE_SIDE_EFFECT]) {
    for (const match of src.matchAll(pattern)) {
      const resolved = resolveSpec(match[1], file);
      if (resolved) out.push(resolved);
    }
  }
  // NOTE: runtime `import()` inside a source module is deliberately NOT an
  // edge here. See `opensDbAtRuntime` below for why, and for the narrower rule
  // that covers it instead.
  edgeCache.set(file, out);
  return out;
}

/**
 * Source modules that open a database through a RUNTIME `import()` of a
 * connection module: `bootstrap.ts`, `memory/usageTracker.ts`,
 * `usage/agentCostFromOtel.ts`.
 *
 * These are a different risk from a static import chain and are handled by a
 * separate rule, because folding them into the static walk is a category
 * error. A static chain freezes `DB_DIR` at module load — unconditionally, for
 * every test in the file. A runtime `import()` captures only when its function
 * is actually CALLED, and if that happens after a reload it resolves
 * correctly.
 *
 * Measured before choosing: propagating these as ordinary edges flagged 30+
 * files, almost all pure-parsing suites whose chain runs
 * `claudeConversations -> subagentEnrichment -> agentCostFromOtel` and which
 * never call the OTEL cost function at all. Treating a conditional runtime
 * edge as an unconditional freeze overstates the risk by that whole margin,
 * and a guard that cries wolf gets routed around (Codex review, PR #419).
 *
 * What is left is narrow and real: a test that imports one of these three
 * directly can trip the runtime import, so it has to be isolated somehow.
 */
// Computed lazily: this walks `src/` using helpers declared further down the
// file, so an eagerly-evaluated module-scope constant hits the temporal dead
// zone.
let runtimeDbOpenersCache: Set<string> | null = null;
function runtimeDbOpeners(): Set<string> {
  if (runtimeDbOpenersCache) return runtimeDbOpenersCache;
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full)) {
        const code = stripComments(fs.readFileSync(full, "utf8"));
        for (const match of code.matchAll(DYNAMIC_IMPORT)) {
          if (isTypePosition(code, match)) continue;
          const resolved = resolveSpec(match[1], full);
          if (resolved && TARGET_FILES.has(resolved)) found.add(full);
        }
      }
    }
  };
  walk(SRC_DIR);
  runtimeDbOpenersCache = found;
  return found;
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
// `import "…";` with no bindings. It has no `from`, so the pattern above never
// sees it — yet it evaluates the module and freezes its path constants just as
// thoroughly (Codex review, PR #419). Nothing in the repo uses this form today
// in `tests/` or `src/`; the pattern is here so the first one is caught.
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']\s*;/gm;
const MOCK_CALL = /vi\.mock\(\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Is this `import("…")` a TYPE query rather than a runtime call?
 *
 * TypeScript spells module types with the same syntax: `typeof import("x")`
 * and `import("x").SomeType` are erased at compile time and load nothing.
 * These files use both — `interface Reloaded { conn: typeof import("@/lib/db/
 * connection") }` is the common shape — so counting them as runtime imports
 * reports a reset-ordering violation on code that never executes.
 *
 * The two forms are told apart by what surrounds them: a preceding `typeof`,
 * or a trailing `.` followed by an Uppercase name. The second is a convention
 * rather than a rule, but it separates `import("x").OtlpMetric` from the only
 * runtime member access that appears on a dynamic import, `.then(`.
 */
function isTypePosition(code: string, match: RegExpExecArray): boolean {
  const before = code.slice(Math.max(0, match.index - 8), match.index);
  if (/\btypeof\s*$/.test(before)) return true;
  const after = code.slice(match.index + match[0].length);
  return /^\s*\.\s*[A-Z]/.test(after);
}

const resolveFrom = (specs: Iterable<string>, from: string): string[] =>
  [...specs].map((s) => resolveSpec(s, from)).filter((f): f is string => f !== null);

/**
 * Source with comments removed, for checks that look for the PRESENCE of a
 * call — a commented-out `state.reload()` must not satisfy the reset check
 * (Copilot review, PR #419).
 *
 * Only whole-line `//` comments and block comments are stripped, never a
 * mid-line `//`: that would eat the rest of any line containing a URL in a
 * string, which is a worse failure than the one being fixed.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const files = listTestFiles(TESTS_DIR).map((full) => {
  const source = fs.readFileSync(full, "utf8");
  // Every check reads `code`, never `source`. A commented-out `vi.mock()` read
  // as a cut vertex would be the worst kind of miss — it would sever a path in
  // the model that is wide open at runtime.
  const code = stripComments(source);
  return {
    name: path.relative(TESTS_DIR, full).split(path.sep).join("/"),
    base: path.basename(full),
    source,
    code,
    staticImports: resolveFrom(
      new Set(
        [...code.matchAll(STATIC_IMPORT), ...code.matchAll(SIDE_EFFECT_IMPORT)].map(
          (m) => m[1]
        )
      ),
      full
    ),
    dynamicImports: resolveFrom(
      new Set(
        [...code.matchAll(DYNAMIC_IMPORT)]
          .filter((m) => !isTypePosition(code, m))
          .map((m) => m[1])
      ),
      full
    ),
    // Mocks are cut vertices. Resolved to files so `vi.mock("@/lib/data")`
    // severs the same node the graph walk reaches as `../data` from
    // elsewhere. Bare specifiers (`fs`, `server-only`) resolve to nothing and
    // simply do not participate — see the tasksDbConnectionRace allowlist note.
    mocked: new Set(
      resolveFrom(new Set([...code.matchAll(MOCK_CALL)].map((m) => m[1])), full)
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
/**
 * Start index of the innermost `{ … }` block containing `at`, or 0 for module
 * scope. Used to ask a narrower question than "does this file reset anywhere".
 */
function enclosingBlockStart(code: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (code[i] === "}") depth++;
    else if (code[i] === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return 0;
}

/**
 * What counts as a module-registry reset IN THIS FILE.
 *
 * `vi.resetModules()` always does. The other form is `reload()` on the handle
 * `installIsolatedState()` returned — and it has to be bound to that handle by
 * name, not accepted as any method called `reload`. A DB-reaching test that
 * happened to call `fixture.reload()` beforehand would otherwise be read as
 * having reset the registry when nothing of the sort ran (Codex review,
 * PR #419).
 */
function resetPattern(code: string): RegExp {
  const handles = [
    ...code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*installIsolatedState\s*\(/g),
  ].map((m) => m[1]);
  const alternatives = ["vi\\.resetModules\\(\\)"];
  for (const handle of handles) alternatives.push(`\\b${handle}\\.reload\\(\\)`);
  return new RegExp(alternatives.join("|"));
}

/**
 * The bodies of every `afterEach` / `afterAll` / `finally` in a file,
 * concatenated.
 *
 * The env rule needs this because "the file mentions `delete process.env.X`
 * somewhere" is not the same claim as "X gets put back". A suite that deletes
 * a variable during setup and assigns it later satisfies the first and fails
 * the second, leaking the final value into the next file in the worker
 * (Codex review, PR #419). Restoration only counts if it runs after the test.
 *
 * `finally` belongs here alongside the hooks. Four files restore an env var in
 * a `try`/`finally` inside the test that set it — `mcpStdioProbe`,
 * `serverMutations`, `serviceScript`, `dbIngestWatcher` — which is at least as
 * good as a hook, since the scope is exactly the code that needs it. An
 * earlier draft accepted only the hooks and flagged all four.
 */
function teardownCode(code: string): string {
  let out = "";
  for (const match of code.matchAll(/\b(?:afterEach|afterAll)\s*\(|\bfinally\s*\{/g)) {
    const open = code.indexOf("{", match.index);
    if (open === -1) continue;
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out += code.slice(open, i) + "\n";
  }
  return out;
}

/**
 * Does a module-registry reset run before this dynamic import, in the same
 * block?
 *
 * A file-wide match was the first version and Codex was right that it stays
 * partially open: one reload anywhere exempts every import in the file,
 * including one that runs before it, and including a second test that imports
 * without reloading at all.
 *
 * What it checks instead is POSITION: a reset has to appear before this import
 * in the import's own block, or in one enclosing it. That catches an import
 * that runs before the file's only reload, and an import in a file whose
 * reload comes later — both of which the file-wide version waved through.
 *
 * KNOWN LIMIT, stated rather than papered over. The walk reaches module scope,
 * so a reset written in a SIBLING function that happens to appear earlier in
 * the file still counts. Stopping at the enclosing function was tried and
 * reverted: several files here reload inside the test and then import inside a
 * thin loader helper — correct code that a regex cannot tell apart from the
 * sibling case, because it requires following the call. Four real files were
 * falsely flagged. A guard that cries wolf on correct code is worse than one
 * with a limit written down, since the first teaches people to route around it.
 *
 * Closing this properly needs the call graph, not another pattern.
 *
 * `installMcpIsolation()` is the one thing accepted file-wide, because it
 * resets inside its own `beforeEach` — which runs first by construction rather
 * than by textual position.
 */
function resetPrecedes(code: string, importAt: number, reset: RegExp): boolean {
  if (/installMcpIsolation\(/.test(code)) return true;
  let at = importAt;
  for (;;) {
    const blockStart = enclosingBlockStart(code, at);
    if (reset.test(code.slice(blockStart, importAt))) return true;
    if (blockStart === 0) return false;
    at = blockStart;
  }
}

function dynamicViolations(file: (typeof files)[number]): string[][] {
  // Note what does NOT count: `installIsolatedState()` alone. It registers
  // lifecycle hooks and allocates the temp home; the module registry is reset
  // only when the caller invokes `state.reload()`. An earlier version accepted
  // the install as evidence, so a file that set isolation up and then forgot
  // the reload before a dynamic import passed this check while still receiving
  // a cached module bound to another home — precisely the leak the guard
  // exists to catch (Codex review, PR #419).
  const out: string[][] = [];
  const reset = resetPattern(file.code);
  for (const match of file.code.matchAll(DYNAMIC_IMPORT)) {
    if (isTypePosition(file.code, match)) continue;
    const imported = resolveSpec(match[1], path.join(TESTS_DIR, file.name));
    if (!imported) continue;
    if (resetPrecedes(file.code, match.index, reset)) continue;
    const chain = unseveredPathFrom(imported, file.mocked);
    if (chain) out.push(chain);
  }
  return out;
}

/**
 * Runtime-opener violations for one file: it statically imports a module that
 * opens a database through `import()`, and the file has no isolation at all.
 */
function runtimeOpenerViolations(file: (typeof files)[number]): string[] {
  // A lifecycle hook, not a bare spy. A `vi.spyOn(os, "homedir")` sitting
  // inside one `it` says nothing about whether it is armed when some other
  // test trips the runtime import — `memoryUsageTracker.test.ts` was exactly
  // that shape, with spies only inside a few pure `canonicalMemoryKey` cases
  // (Codex review, PR #419). A hook runs for every test in its scope, which is
  // the property this rule actually needs.
  const isolated =
    /installIsolatedState\(/.test(file.code) || /installMcpIsolation\(/.test(file.code);
  if (isolated) return [];
  const openers = runtimeDbOpeners();
  const out: string[] = [];
  for (const imported of file.staticImports) {
    if (!openers.has(imported)) continue;
    if (file.mocked.has(imported)) continue;
    out.push(rel(imported));
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
      if (ALLOWLIST.has(file.name)) continue;
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
      if (ALLOWLIST.has(file.name)) continue;
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

  it("no test mutates process.env without arranging for it to be put back", () => {
    // Added because the migration in this PR dropped eight files' `MINDER_USE_DB`
    // save/restore and nothing failed (Codex review, PR #419). Vitest reuses a
    // worker process across files, so a variable left set escapes into whatever
    // file runs next — there it silently selects the file backend instead of
    // the DB one, and the victim is a suite that never mentions the variable.
    // Invisible in exactly the way the rest of this guard exists to prevent.
    //
    // A file satisfies the rule three ways: hand the variable to
    // installIsolatedState (`env` for one it sets, `preserveEnv` for one its
    // tests set case by case), restore it by hand, or use vitest's own
    // `stubEnv`. Note `dbIngest.test.ts` was already leaking before the
    // migration — the rule catches pre-existing cases too, which is why it is
    // worth having rather than just fixing the eight.
    const violations: string[] = [];
    for (const file of files) {
      const install = /installIsolatedState\(\{[\s\S]*?\}\);/.exec(file.code);
      const teardown = teardownCode(file.code);
      // Two ways to mutate the environment, and both leak. `vi.stubEnv` only
      // self-restores when `test.unstubEnvs` is enabled in the vitest config,
      // which this repo does NOT set — `bootstrap.test.ts`, the one file using
      // stubs, calls `vi.unstubAllEnvs()` in its own afterEach. A stub was
      // previously invisible to this rule entirely (Codex review, PR #419).
      //
      // A `delete` is a mutation too (#421). Deleting an INHERITED variable
      // erases it for every file that runs afterwards in the same worker, and
      // unlike an assignment nothing puts it back. Most of the sites here
      // delete as the teardown for their own assignment, which is correct when
      // the variable started unset and lossy when it did not — and the two are
      // indistinguishable from the source, which is exactly why the rule has to
      // ask for a saved original rather than for the absence of a value.
      const mutations = [
        ...[...file.code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*=(?!=)/g)].map(
          (m) => ({ name: m[1], stub: false })
        ),
        ...[
          ...file.code.matchAll(/delete\s+process\.env\.([A-Z][A-Z0-9_]*)/g),
        ].map((m) => ({ name: m[1], stub: false })),
        ...[...file.code.matchAll(/vi\.stubEnv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map(
          (m) => ({ name: m[1], stub: true })
        ),
      ];
      for (const { name, stub } of mutations) {
        // `HOME`, `USERPROFILE` and `MINDER_STATE_DIR` are saved and restored
        // by installIsolatedState unconditionally — they are the isolation
        // invariant, not caller options — so they never appear in the options
        // text a file writes.
        const HELPER_MANAGED = ["HOME", "USERPROFILE", "MINDER_STATE_DIR"];
        // `preserveEnvVars([...])` is the light half of the same contract:
        // save on entry, write the original back on exit, for files that need
        // the environment restored but not a temp home or a module reset.
        const preserve = /preserveEnvVars\(\[[\s\S]*?\]\)/.exec(file.code);
        const declared =
          (install !== null &&
            (install[0].includes(name) || HELPER_MANAGED.includes(name))) ||
          (preserve !== null && preserve[0].includes(name));
        // Each alternative is bound to THIS variable and has to sit in
        // teardown. A bare `stubEnv` token anywhere used to exempt every
        // assignment in the file, and a `delete` in setup counted as a restore
        // for an assignment that came after it (Codex review).
        //
        // `unstubAllEnvs()` restores stubs and only stubs, so it answers for a
        // `vi.stubEnv` mutation and NOT for a direct assignment — matching what
        // vitest actually undoes.
        // A bare `delete` in teardown used to satisfy this. It no longer does
        // (#421): it restores the file's OWN assignment and destroys anything
        // the file inherited, and the guard cannot tell those apart. Only
        // writing back a captured original counts — or a conditional delete
        // guarded on that original having been `undefined`, which is what the
        // capture-and-restore shape looks like when the variable was unset.
        const restoresThis = stub
          ? /unstubAllEnvs\s*\(/
          : new RegExp(
              `process\\.env\\.${name}\\s*=\\s*(original|saved|prev)|` +
                `\\b(original|saved|prev)\\w*\\s*===?\\s*undefined\\s*\\)?\\s*` +
                `(\\{\\s*)?delete process\\.env\\.${name}\\b`,
              "i"
            );
        if (declared || restoresThis.test(teardown)) continue;
        violations.push(
          stub
            ? `${file.name} calls vi.stubEnv("${name}") with no ` +
              `vi.unstubAllEnvs() in teardown — vitest only restores stubs ` +
              `automatically when test.unstubEnvs is enabled, and this repo ` +
              `does not set it, so the value escapes into the next file in ` +
              `the same worker.`
            : `${file.name} mutates process.env.${name} (assign or delete) and ` +
              `never puts the ORIGINAL back — it escapes into the next file in ` +
              `the same vitest worker. Declare it in installIsolatedState's ` +
              `env/preserveEnv, pass it to preserveEnvVars([...]), or write a ` +
              `captured original back in a teardown hook or a finally. A bare ` +
              `delete is not a restore: it erases an inherited value.`
        );
      }
    }
    expect([...new Set(violations)]).toEqual([]);
  });

  it("finds the runtime DB openers it is about to check", () => {
    // The walk is the whole basis of the next test; if it silently found
    // nothing, that test would pass by vacuity.
    const openers = [...runtimeDbOpeners()].map(rel).sort();
    expect(openers).toEqual([
      // #513: the endpoint reports whether the corpus was fully read, and the
      // DB reconcile's own verdict lives on its run row — the reconcile runs in
      // a worker whose `globalThis` cannot reach this process, so the shared
      // file is the only evidence. Opened dynamically, behind `probeInitStatus`
      // and a try/catch, so a probe can never break the endpoint that reports
      // completeness.
      "src/app/api/claude-homes/route.ts",
      "src/lib/bootstrap.ts",
      "src/lib/memory/usageTracker.ts",
      "src/lib/usage/agentCostFromOtel.ts",
    ]);
  });

  it("isolates any test that imports a module opening the DB at runtime", () => {
    // The narrow, real half of the runtime-import problem (see
    // runtimeDbOpeners()). Importing one of those modules freezes nothing on
    // its own, so this does not ask for a dynamic import — it asks that the
    // file be isolated at all, by any of the three means the suite uses, so
    // that if the runtime import does fire it resolves under a temp home.
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file.name)) continue;
      for (const opener of runtimeOpenerViolations(file)) {
        violations.push(
          `${file.name} imports ${opener}, which opens a database ` +
            `through a runtime import(), but the file has no isolation. If ` +
            `that code path runs it resolves against the developer's real ` +
            `~/.minder. Install isolatedState (or mock the module).`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    // An allowlist entry for a file that no longer violates anything is a
    // standing exception nobody re-examines. Fail so it gets deleted.
    const stale: string[] = [];
    for (const [name] of ALLOWLIST) {
      const file = files.find((f) => f.name === name);
      if (!file) {
        stale.push(`${name} is allowlisted but no such test file exists`);
        continue;
      }
      const total =
        staticViolations(file).length +
        dynamicViolations(file).length +
        runtimeOpenerViolations(file).length;
      if (total === 0) {
        stale.push(`${name} is allowlisted but no longer needs to be`);
      }
    }
    expect(stale).toEqual([]);
  });
});
