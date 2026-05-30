import { spawn } from "child_process";
import path from "path";
import type { LintFinding, LintReport, LintTarget } from "../types";

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
  const pkgRoot = path.dirname(require.resolve("claude-code-lint/package.json"));
  return path.join(pkgRoot, "bin", "claudelint");
}

/**
 * Spawn `claude-code-lint check-all --format json` in the given project
 * directory, parse the output, and return findings. Any failure (spawn error,
 * timeout, JSON parse error) is recorded in `engineErrors` and returns [].
 *
 * Non-zero CLI exit is expected when linting errors are found; we always
 * resolve on process close and parse whatever stdout arrived.
 */
export async function runLibraryCli(
  projectPath: string,
  engineErrors: LintReport["engineErrors"],
  timeoutMs = 20_000,
): Promise<LintFinding[]> {
  const { stdout, error } = await spawnClaudelint(
    "check-all",
    ["--format", "json"],
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
  const cliBin = resolveClaudelintBin();
  return new Promise((resolve) => {
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
