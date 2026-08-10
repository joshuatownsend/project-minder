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
  const src = fs.readFileSync(file, "utf8");
  for (const pattern of [EDGE, EDGE_SIDE_EFFECT]) {
    for (const match of src.matchAll(pattern)) {
      const resolved = resolveSpec(match[1], file);
      if (resolved) out.push(resolved);
    }
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

const RESET_CALL = /vi\.resetModules\(\)|\.reload\(\)/;

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
function resetPrecedes(code: string, importAt: number): boolean {
  if (/installMcpIsolation\(/.test(code)) return true;
  let at = importAt;
  for (;;) {
    const blockStart = enclosingBlockStart(code, at);
    if (RESET_CALL.test(code.slice(blockStart, importAt))) return true;
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
  for (const match of file.code.matchAll(DYNAMIC_IMPORT)) {
    if (isTypePosition(file.code, match)) continue;
    const imported = resolveSpec(match[1], path.join(TESTS_DIR, file.name));
    if (!imported) continue;
    if (resetPrecedes(file.code, match.index)) continue;
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
      for (const match of file.code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*=(?!=)/g)) {
        const name = match[1];
        // `HOME`, `USERPROFILE` and `MINDER_STATE_DIR` are saved and restored
        // by installIsolatedState unconditionally — they are the isolation
        // invariant, not caller options — so they never appear in the options
        // text a file writes.
        const HELPER_MANAGED = ["HOME", "USERPROFILE", "MINDER_STATE_DIR"];
        const declared =
          install !== null && (install[0].includes(name) || HELPER_MANAGED.includes(name));
        // Each alternative is bound to THIS variable, and — apart from
        // `vi.stubEnv`, which vitest restores itself — has to sit in a
        // teardown hook. A bare `stubEnv` token anywhere used to exempt every
        // assignment in the file, and a `delete` in setup counted as a
        // restore for an assignment that came after it (Codex review).
        const restoresThis = new RegExp(
          `delete process\\.env\\.${name}\\b|` +
            `process\\.env\\.${name}\\s*=\\s*(original|saved|prev)|` +
            `unstubAllEnvs`
        );
        const stubbed = new RegExp(`stubEnv\\(\\s*["']${name}["']`).test(file.code);
        if (declared || stubbed || restoresThis.test(teardown)) continue;
        violations.push(
          `${file.name} sets process.env.${name} and never restores it — it ` +
            `escapes into the next file in the same vitest worker. Declare it ` +
            `in installIsolatedState's env/preserveEnv, restore it in a ` +
            `teardown hook, or use vi.stubEnv.`
        );
      }
    }
    expect([...new Set(violations)]).toEqual([]);
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
