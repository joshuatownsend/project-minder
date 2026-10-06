import { spawn } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import type { LintFinding, LintReport, LintTarget } from "../types";
import {
  getCachedLintReport,
  lintCacheEnabled,
  lintCliCacheDir,
  lintFingerprint,
  putCachedLintReport,
} from "./resultCache";

// Map library validator names → our LintTarget values.
// "CLAUDE.md Validator" is intentionally absent — the adapter pass handles it.
const VALIDATOR_TARGET: Partial<Record<string, LintTarget>> = {
  "Skills Validator":       "skill",
  "Agents Validator":       "agent",
  "Output Styles Validator":"output-style",
  "LSP Validator":          "lsp",
  "Settings Validator":     "settings",
  "Hooks Validator":        "hook",
  "MCP Validator":          "mcp",
  "Plugin Validator":       "plugin",
  "Commands Validator":     "command",
};

interface CliMessage {
  message: string;
  file?: string;
  ruleId?: string;
  explanation?: string;
  howToFix?: string;
  severity: "error" | "warning" | "info";
}

interface CliReport {
  validators?: Array<{ name: string; errors?: CliMessage[]; warnings?: CliMessage[] }>;
}

/**
 * Resolve the `claudelint` CLI bin path via the package's declared bin
 * entry — not a path assumption relative to main (main → dist/index.js,
 * bin → bin/claudelint). Shared with the formatter wrapper so both spawn
 * the same binary.
 */
export function resolveClaudelintBin(): string {
  // The specifier is a variable, and that is load-bearing rather than style.
  //
  // Given the string literal, Turbopack resolves it into its OWN module graph
  // at build time and substitutes a numeric module id, so the production
  // bundle read `path.dirname(31985)` — which throws
  // `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string.
  // Received type number`. The call sites catch it, so every shipped build
  // recorded "Failed to resolve claudelint bin" in `engineErrors` and returned
  // no findings: the library lint engine was dead in every release, silently,
  // while its 50 MB dependency shipped unused. (#533.)
  //
  // A non-literal argument defeats that static substitution and leaves a real
  // `require.resolve` in the output. The same reasoning as the
  // `/* turbopackIgnore: true */` annotations in `serverRoot.ts` and
  // `migrations.ts`; here the indirection is what the bundler cannot see
  // through, and `packagedLintBinCandidates` in package-standalone.mjs keeps a
  // resolvable `claude-code-lint` at the payload's top level so the resolve has
  // something to find away from a checkout.
  const specifier = "claude-code-lint/package.json";
  const pkgRoot = path.dirname(require.resolve(/* turbopackIgnore: true */ specifier));
  return path.join(pkgRoot, "bin", "claudelint");
}

/** The installed CLI's version: part of the cache key, so an upgrade re-lints everything. */
let cliVersionMemo: string | undefined;
function claudelintVersion(): string {
  if (cliVersionMemo !== undefined) return cliVersionMemo;
  try {
    const pkgPath = path.join(path.dirname(resolveClaudelintBin()), "..", "package.json");
    cliVersionMemo = String((JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version ?? "unknown");
  } catch {
    cliVersionMemo = "unknown";
  }
  return cliVersionMemo;
}

/**
 * Lint a project with `claude-code-lint check-all --format json` and return findings. The CLI
 * costs ~2 s per project, so a result is reused while nothing it could read has changed
 * (`resultCache.ts`). Any failure (spawn error, timeout, JSON parse error) is recorded in
 * `engineErrors`, returns [], and is never cached.
 *
 * Non-zero CLI exit is expected when linting errors are found; we always
 * resolve on process close and parse whatever stdout arrived.
 */
export async function runLibraryCli(
  projectPath: string,
  engineErrors: LintReport["engineErrors"],
  timeoutMs = 20_000,
): Promise<LintFinding[]> {
  const cacheOn = lintCacheEnabled();
  const version = cacheOn ? claudelintVersion() : "";
  // Computed BEFORE the spawn: if a file changes while the CLI runs, the stored fingerprint
  // is already stale and the next scan misses, rather than blessing a result it never saw.
  const fingerprint = cacheOn && version !== "unknown" ? await lintFingerprint(projectPath, version) : null;
  if (fingerprint) {
    const hit = await getCachedLintReport(projectPath, fingerprint);
    if (hit) return reportToFindings(hit as CliReport); // stored from a CliReport below
  }

  const { stdout, error } = await spawnClaudelint(
    "check-all",
    // The CLI would otherwise write `.claudelint-cache/` into the project (#610).
    ["--format", "json", "--cache-location", lintCliCacheDir(projectPath)],
    projectPath,
    timeoutMs,
  );
  if (error) {
    engineErrors.push({ engine: "library", message: error });
    return [];
  }

  if (!stdout.trim()) return [];

  let report: CliReport;
  try {
    report = JSON.parse(stdout) as CliReport;
  } catch {
    engineErrors.push({ engine: "library", message: "Failed to parse CLI JSON output" });
    return [];
  }

  if (fingerprint) {
    await putCachedLintReport(projectPath, fingerprint, {
      validators: (report.validators ?? []).map((v) => ({ name: v.name, errors: v.errors, warnings: v.warnings })),
    });
  }
  return reportToFindings(report);
}

function reportToFindings(report: CliReport): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const validator of report.validators ?? []) {
    const target = VALIDATOR_TARGET[validator.name];
    if (!target) continue;
    const messages = [...(validator.errors ?? []), ...(validator.warnings ?? [])];
    for (const msg of messages) {
      findings.push(toFinding(msg, target));
    }
  }
  return findings;
}

function toFinding(msg: CliMessage, target: LintTarget): LintFinding {
  const isError = msg.severity === "error";
  const code = `${target}/${msg.ruleId ?? "unknown"}`;
  return {
    target,
    code,
    severity: isError ? "P1" : "P2",
    title: msg.message,
    fix: msg.howToFix ?? msg.explanation ?? "",
    penalty: isError ? 5 : 2,
    engine: "library",
    ...(msg.file ? { file: msg.file } : {}),
    docsUrl: msg.ruleId
      ? `https://claudelint.com/rules/${msg.ruleId}`
      : undefined,
  };
}

/**
 * Spawn `claudelint <subcommand> <args...>` in `cwd`. Resolves with stdout
 * regardless of exit code (a non-zero exit just means findings/format issues
 * exist), and resolves `{ error }` rather than rejecting on a spawn failure —
 * a degrade-don't-throw contract both the linter pass and the formatter
 * wrapper rely on. The single home for the stdio + timeout + `process.execPath
 * + bin` invocation invariant, alongside `resolveClaudelintBin`.
 */
export function spawnClaudelint(
  subcommand: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let cliBin: string;
    try {
      // Resolve inside the Promise so a resolution failure honors the
      // degrade-don't-throw contract instead of throwing synchronously and
      // taking down the entire scan (e.g. when bundling rewrites the dynamic
      // require.resolve, or the package is absent).
      cliBin = resolveClaudelintBin();
    } catch (err) {
      resolve({ stdout: "", error: `Failed to resolve claudelint bin: ${String(err)}` });
      return;
    }
    const child = spawn(
      process.execPath,
      [cliBin, subcommand, ...args],
      { cwd, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    // Non-zero exit is normal; resolve with whatever stdout arrived.
    child.on("close", () => resolve({ stdout: out }));
    child.on("error", (err) => resolve({ stdout: out, error: String(err) }));
  });
}
