// Captures the landing-page screenshots in TWO passes and merges them.
//
// Why two passes: demo mode (MINDER_DEMO=1) replaces the read surfaces with
// synthetic fixtures, which is what we want for the marketing page — a tidy
// 8-project portfolio reads better than a real 60-project one, and the fixtures
// are shareable. But an audit of every captured route (2026-08-12) found demo
// fixtures only reach about half of them: roughly 18 screens render empty or
// near-empty under demo mode (/kanban, /tasks, /swarms, /templates, /sql,
// /schedule, /health, /insights-report, the /memory sub-pages, …), which would
// publish a set of blank screenshots.
//
// So: the REAL pass captures everything, and the DEMO pass then overwrites only
// the shots listed in DEMO_OWNED — the ones where fixtures are genuinely richer.
// Anything not listed keeps its real-data capture. Adding a name here is safe
// only after looking at the demo version of that shot.
//
// Usage:  node scripts/capture-screenshots-hybrid.mjs
//         node scripts/capture-screenshots-hybrid.mjs --skip-build
//         node scripts/capture-screenshots-hybrid.mjs --real-only
//         node scripts/capture-screenshots-hybrid.mjs --demo-only   (reuses build)

import { spawn } from 'child_process';
import { mkdtempSync, copyFileSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SHOTS_DIR = join(REPO_ROOT, 'site', 'screenshots');
const IS_WIN = process.platform === 'win32';

// The project the demo pass uses for per-project shots. Demo mode has no
// `project-minder`; aurora-commerce is the fixture with the fullest tab set
// (Overview, TODOs, Sessions, Costs, Timecard, Manual Steps, Insights, Board,
// Ops, Memory, Agents, Skills, Efficiency).
const DEMO_PROJECT = process.env.MINDER_CAPTURE_PROJECT || 'aurora-commerce';

// Shots the demo pass owns. Everything else keeps its real-data capture.
const DEMO_OWNED = [
  'dashboard',          // Home overview, fixture spend/activity
  'projects-grid',      // 8 tidy fixture cards vs ~60 real ones
  'card-detail',        // element crop of a fixture project's card
  'project-detail',     // aurora-commerce overview
  'todos-tab',          // aurora-commerce has fixture TODOs
  'sessions-browser',   // fixture sessions with readable titles
  'session-detail',
  'insights-browser',
  'manual-steps',
  'setup',
  'agents',
  'skills',
  'costs',
  'ops-panel',          // aurora-commerce Ops tab
  'github-activity',    // fixture repo shows open PRs + CI
];

// Three shots that LOOK like they belong in DEMO_OWNED and do not. Each was
// promoted, inspected, and moved back out — recorded here so the next person
// does not re-add them on the same reasoning:
//
//   usage-dashboard  /usage throws a client-side "circular link" error under
//                    demo mode (dev AND prod builds) and renders Chromium's
//                    "This page couldn't load" instead of the app. See #443.
//                    Demo bought nothing anyway — demo /usage still surfaced a
//                    real project name.
//   memory           Demo fixtures ship no memory files, so the tab renders
//                    "No memory files yet for this project" — an empty state
//                    directly contradicting the prose it illustrates.
//   stats-dashboard  Renders richly, but its cross-check panel compares the
//                    demo totals against the REAL Claude stats cache and shows
//                    a red "-91% / -100%" drift, which reads as a broken app.
//
// The general lesson: "the demo pass produced a file" is not evidence the file
// is good. Look at it.

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: IS_WIN,
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
  });
}

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const realOnly = has('--real-only');
const demoOnly = has('--demo-only');
// --demo-only implies an existing build; there is nothing for it to rebuild.
const skipBuild = has('--skip-build') || demoOnly;

(async () => {
  if (!demoOnly) {
    console.log('\n══ PASS 1/2 — real data ══════════════════════════════\n');
    await run('node', ['scripts/capture-screenshots-prod.mjs'], {
      MINDER_CAPTURE_SKIP_BUILD: skipBuild ? '1' : '',
      // Explicitly clear demo mode: this pass must not inherit it from the
      // caller's shell, or "real" and "demo" would capture the same thing.
      MINDER_DEMO: '',
      // Don't spend real-server time on shots pass 2 is going to overwrite.
      // This is a correctness measure, not just a speed one — see DEMO_OWNED.
      MINDER_CAPTURE_SKIP: DEMO_OWNED.join(','),
    });
  }

  if (realOnly) {
    console.log('\n✓ --real-only: skipping the demo pass.\n');
    return;
  }

  const demoOut = mkdtempSync(join(tmpdir(), 'minder-demo-shots-'));
  console.log(`\n══ PASS 2/2 — demo fixtures ══════════════════════════`);
  console.log(`   project: ${DEMO_PROJECT}`);
  console.log(`   staging: ${demoOut}\n`);

  try {
    // A non-zero exit from the demo pass is EXPECTED and must not abort us.
    // The capture scripts fail the run when a shot misses its content guards,
    // and under demo mode that is the correct outcome for the ~18 screens
    // fixtures leave empty (/timecard, /kanban, /swarms, …) — shots this
    // script never promotes. Aborting here would discard the demo captures we
    // actually want because a shot we intended to ignore came out blank.
    //
    // The real gate is the DEMO_OWNED existence check below: if a shot we DO
    // promote failed to materialise, that sets a non-zero exit.
    await run('node', ['scripts/capture-screenshots-prod.mjs'], {
      MINDER_DEMO: '1',
      MINDER_CAPTURE_OUT: demoOut,
      MINDER_CAPTURE_PROJECT: DEMO_PROJECT,
      // The deck script targets the Ops shot with its OWN slug, defaulting to
      // `perfect-palette` — a real project that does not exist under demo
      // fixtures. Without this the Ops tab guard fails and `ops-panel` never
      // materialises, so it would silently keep its real-data capture despite
      // being listed in DEMO_OWNED.
      MINDER_CAPTURE_OPS_PROJECT: DEMO_PROJECT,
      // Pass 1 just built; never rebuild between passes.
      MINDER_CAPTURE_SKIP_BUILD: '1',
    }).catch((err) => {
      console.warn(`\n  ⚠  Demo pass reported failures: ${err.message}`);
      console.warn('     Expected — demo fixtures leave some screens empty.');
      console.warn('     Continuing to promotion; the DEMO_OWNED check below is the real gate.\n');
    });

    console.log('\n══ Promoting demo-owned shots ════════════════════════\n');
    const promoted = [];
    const missing = [];
    for (const name of DEMO_OWNED) {
      const src = join(demoOut, `${name}.png`);
      if (!existsSync(src)) { missing.push(name); continue; }
      copyFileSync(src, join(SHOTS_DIR, `${name}.png`));
      promoted.push(`${name} (${(statSync(src).size / 1024).toFixed(0)}KB)`);
    }
    promoted.forEach((p) => console.log(`  ✓ ${p}`));

    if (missing.length) {
      // A demo-owned shot the demo pass never produced means the real-data
      // version is still in place — silently, under a name this script claims
      // to own. Say so loudly rather than let it pass as a demo capture.
      console.error(`\n  ⚠  demo pass produced no file for: ${missing.join(', ')}`);
      console.error('     Those keep their real-data capture. Investigate before publishing.');
      process.exitCode = 1;
    }

    // Report what the demo pass captured but we deliberately did NOT promote,
    // so the DEMO_OWNED list can be revisited against real output.
    const staged = readdirSync(demoOut)
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace(/\.png$/, ''));
    const notPromoted = staged.filter((n) => !DEMO_OWNED.includes(n));
    console.log(`\n  ${notPromoted.length} demo shots left unpromoted (kept real data):`);
    console.log(`    ${notPromoted.join(', ')}`);
    console.log(`\n  Staged demo shots kept for inspection at:\n    ${demoOut}\n`);
  } catch (err) {
    // Leave the staging dir behind on failure — it is the evidence.
    console.error(`\n✗ Demo pass failed: ${err.message}`);
    console.error(`  Staged output (may be partial): ${demoOut}`);
    throw err;
  }

  console.log('✓ Hybrid capture complete.\n');
})().catch((err) => {
  console.error('\n✗ Hybrid capture failed:', err.message);
  process.exit(1);
});
