import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveClaudelintBin } from "@/lib/lint/library";
import { lintFingerprint } from "@/lib/lint/resultCache";

// #617 — the fingerprint is an allowlist of what the lint CLI reads, so it can only be as complete as
// our reading of the CLI. This test removes the guesswork: it runs the REAL installed CLI under an fs
// tracer over a fixture that exercises every file-reading rule we know of, then proves that changing
// ANY file the CLI touched moves the fingerprint.
//
// If a claude-code-lint upgrade starts reading something new, this fails on the Dependabot bump
// naming the path, instead of the cache serving stale results for up to four hours.

const TRACER = path.join(process.cwd(), "tests", "_helpers", "fsTrace.cjs");

let base: string;
let home: string;
let project: string;
let traced: string[] = [];

const w = (abs: string, content: string) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

/** One project touching every reader we know of: imports, skill links, hook scripts, settings, MCP. */
function buildFixture() {
  const p = (rel: string) => path.join(project, rel);
  w(p("CLAUDE.md"), [
    "# Project",
    "",
    "Imports: @docs/extra.md and @../outside-import.md and @~/home-import.md and @/abs-import.md",
    "Chain: @docs/chain-a.md",
    "Missing: @docs/does-not-exist.md",
    "Not paths: @Injectable @param",
    "",
  ].join("\n"));
  w(p("docs/extra.md"), "extra\n");
  w(p("docs/chain-a.md"), "@chain-b.md\n");
  w(p("docs/chain-b.md"), "@chain-a.md\n"); // circular
  w(path.join(base, "outside-import.md"), "outside\n");
  w(p(".claude/rules/style.md"), "@../../docs/extra.md\n");
  w(p("CLAUDE.local.md"), "@docs/local-only.md\n");
  w(p("skills/foo/SKILL.md"), [
    "---", "name: foo", "description: Does foo. Use when testing the fingerprint.", "---", "# Foo", "",
    "See [a](./ref.md), [b](../shared/notes.md), [c](../../../outside-link.md), [d](references/deep.md), [e](missing.md).",
    "```", "[fenced](./in-a-fence.md)", "```", "",
  ].join("\n"));
  w(p("skills/foo/ref.md"), "ref\n");
  w(p("skills/shared/notes.md"), "notes\n");
  w(p("skills/foo/references/deep.md"), "deep\n");
  w(p("skills/foo/NOTES.md"), "[x](./only-in-notes.md)\n");
  w(p("agents/a.md"), "---\nname: a\ndescription: an agent\n---\nBody\n");
  w(p("commands/c.md"), "---\ndescription: a command\n---\nBody\n");
  w(p("hooks/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./scripts/pre.sh" }] }] } }));
  w(p("scripts/pre.sh"), "#!/bin/sh\n");
  w(p(".claude/settings.json"), JSON.stringify({ permissions: { allow: [] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "./scripts/stop.sh" }] }] } }));
  w(p(".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "node", args: ["server.js"] } } }));
  w(p(".gitignore"), "ignored/\n");
  w(p("package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  w(p("ignored/CLAUDE.md"), "@docs/ignored-import.md\n");
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lint-conf-")));
  home = path.join(base, "home");
  project = path.join(base, "proj");
  fs.mkdirSync(home, { recursive: true });
  buildFixture();

  const traceFile = path.join(base, "trace.txt");
  const result = spawnSync(process.execPath, [resolveClaudelintBin(), "check-all", "--format", "json", "--no-cache"], {
    cwd: project,
    encoding: "utf-8",
    maxBuffer: 1 << 26,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      FSTRACE_OUT: traceFile,
      NODE_OPTIONS: `--require ${TRACER.split(path.sep).join("/")}`,
    },
  });
  // exit 1 just means findings were reported; the run must still have produced a report
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  traced = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf-8").split("\n").filter(Boolean) : [];
}, 120_000);

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** The paths under the fixture (not the CLI's own install, not its home-directory state) it touched. */
function touchedUnderFixture(): string[] {
  return [...opsUnderFixture().keys()].sort();
}

/** Each such path with the fs operations the CLI used on it. */
function opsUnderFixture(): Map<string, Set<string>> {
  const inside = (abs: string) => abs.startsWith(base + path.sep) && !abs.startsWith(home + path.sep) && abs !== home;
  const ops = new Map<string, Set<string>>();
  for (const line of traced) {
    const at = line.indexOf(" ");
    const abs = line.slice(at + 1);
    if (!inside(abs) || abs.includes(`${path.sep}node_modules${path.sep}`) || abs === path.join(base, "trace.txt")) continue;
    ops.set(abs, (ops.get(abs) ?? new Set()).add(line.slice(0, at).replace(/^p\./, "")));
  }
  return ops;
}

/** A path the CLI only ever LISTS is a directory it expected; creating a file there would test nothing. */
const LISTING_OPS = new Set(["readdir", "readdirSync", "opendir", "opendirSync"]);

describe("lint fingerprint conformance (claude-code-lint, traced)", () => {
  it("the tracer saw the probes this test depends on (so an empty trace cannot pass vacuously)", () => {
    const seen = new Set(touchedUnderFixture());
    for (const expected of [
      path.join(base, "outside-import.md"), // an @import that leaves the project
      path.join(base, "outside-link.md"), // a SKILL.md link that leaves the project
      path.join(project, "docs", "extra.md"),
      path.join(project, "skills", "foo", "ref.md"),
      path.join(project, "skills", "foo", "missing.md"),
      path.join(project, "CLAUDE.md"),
    ]) {
      expect(seen, `expected the CLI to touch ${expected}`).toContain(expected);
    }
  });

  it("does not read what we claim it does not (gitignore files, links in fences or non-skill markdown)", () => {
    const seen = touchedUnderFixture();
    expect(seen.filter((p) => path.basename(p) === ".gitignore" && p.startsWith(project))).toEqual([]);
    expect(seen).not.toContain(path.join(project, "skills", "foo", "in-a-fence.md"));
    expect(seen).not.toContain(path.join(project, "skills", "foo", "only-in-notes.md"));
  });

  it("every file the CLI touched moves the fingerprint when it changes", async () => {
    const baseline = await lintFingerprint(project, "1.0.0");
    expect(baseline).not.toBeNull();

    const untracked: string[] = [];
    const ops = opsUnderFixture();
    for (const target of touchedUnderFixture()) {
      let kind: "file" | "dir" | "missing";
      try {
        kind = fs.statSync(target).isDirectory() ? "dir" : "file";
      } catch {
        kind = "missing";
      }
      if (kind === "dir") continue; // directories are covered by the tree walk; a listing cannot be "edited"

      let restore: () => void;
      if (kind === "file") {
        const original = fs.readFileSync(target);
        fs.appendFileSync(target, "\n<!-- conformance edit -->\n");
        restore = () => fs.writeFileSync(target, original);
      } else {
        const firstMissing = (() => {
          let d = path.dirname(target);
          let top = target;
          while (!fs.existsSync(d)) {
            top = d;
            d = path.dirname(d);
          }
          return top;
        })();
        const listedOnly = [...(ops.get(target) ?? [])].every((op) => LISTING_OPS.has(op));
        w(listedOnly ? path.join(target, "created-by-conformance.md") : target, "created by the conformance test\n");
        restore = () => fs.rmSync(firstMissing, { recursive: true, force: true });
      }
      try {
        const after = await lintFingerprint(project, "1.0.0");
        if (after === baseline) untracked.push(`${kind === "missing" ? "creating" : "editing"} ${path.relative(base, target)}`);
      } finally {
        restore();
      }
      // and the restore really restored: otherwise later iterations would measure the wrong thing
      expect(await lintFingerprint(project, "1.0.0")).toBe(baseline);
    }
    expect(untracked, "the CLI reads these but the fingerprint does not see them change").toEqual([]);
  }, 120_000);
});
