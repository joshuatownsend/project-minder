// Builds Next.js for production, starts `next start` on a side-port, polls
// until ready, runs the three capture scripts against it, then tears down.
//
// Why prod over dev for captures: Next.js dev recompiles routes lazily on
// each visit and emits a "Compiling…" pill, and dev data fetches are much
// slower (e.g. /api/usage aggregating 4400+ sessions takes ~19s in dev vs
// ~1s in prod). The 2026-05-16 docs refresh shipped with one residual
// skeleton frame in /usage as a result; this script eliminates that whole
// category of flake.

import { spawn, spawnSync } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PORT = Number(process.env.MINDER_CAPTURE_PORT) || 4101;
const BASE = `http://localhost:${PORT}`;
const IS_WIN = process.platform === 'win32';
const NEXT_BIN = join(REPO_ROOT, 'node_modules', '.bin', IS_WIN ? 'next.cmd' : 'next');
// The server prints "Ready" in ~1s but cannot serve a request until its boot
// sequence finishes — the DB probe alone was measured at ~75s against a
// 6,000-session index, with the project scan and cache priming after it (~105s
// total, and slower while a build is still flushing to disk). The old 120s
// budget sat right on that edge and failed the run outright.
const READY_TIMEOUT_MS = Number(process.env.MINDER_CAPTURE_READY_TIMEOUT || 420_000);
const READY_POLL_MS = 2_000;

// Hold the server reference so signal handlers can kill it.
let server = null;
let shuttingDown = false;

// `next start` cannot serve a standalone build, and this repo sets
// `output: "standalone"` for the Tauri sidecar. Both the build and the server
// read next.config.ts, so this has to be set for both — see the matching
// comment in next.config.ts.
process.env.MINDER_BUILD_NO_STANDALONE = '1';

// Captures only READ the index; they never need it updated. Leaving the indexer
// on makes boot slower and competes with the browser for CPU for the whole run,
// on top of the boot wait above. Reads are unaffected — this disables automatic
// index updates, not the queries the screenshots depend on.
if (process.env.MINDER_INDEXER === undefined) process.env.MINDER_INDEXER = '0';

async function run(cmd, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: IS_WIN, // Windows needs shell to resolve .cmd shims via npm
      env,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

async function waitForReady() {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const resp = await fetch(BASE + '/', { signal: AbortSignal.timeout(5_000) });
      if (resp.ok) return;
    } catch {
      // not up yet
    }
    await delay(READY_POLL_MS);
  }
  throw new Error(`Server at ${BASE} did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
}

// Demo fixtures ship a fixed set of synthetic projects. Seeing one of them in
// /api/projects is proof the demo branch is serving; seeing none means the flag
// did not reach the server.
const DEMO_FIXTURE_SLUGS = [
  'aurora-commerce', 'pulse-analytics', 'quill-cms', 'ledger-api',
  'atlas-cli', 'beacon-mobile', 'synth-playground', 'archive-legacy-dash',
];

async function assertDemoFixturesLive() {
  const resp = await fetch(`${BASE}/api/projects`, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`Demo check: /api/projects returned ${resp.status}`);
  }
  const data = await resp.json();
  const projects = Array.isArray(data) ? data : (data.projects ?? []);
  const slugs = new Set(projects.map((p) => p?.slug));
  const found = DEMO_FIXTURE_SLUGS.filter((s) => slugs.has(s));
  if (found.length === 0) {
    throw new Error(
      'MINDER_DEMO=1 was set but /api/projects returned no demo fixture projects ' +
      `(saw ${projects.length}: ${[...slugs].slice(0, 5).join(', ')}...). ` +
      'Refusing to capture — these shots would contain real data.',
    );
  }
  console.log(`\n✓ Demo mode confirmed live (${found.length} fixture projects present).`);
}

async function killServer() {
  if (!server || shuttingDown) return;
  shuttingDown = true;
  console.log('\n→ Tearing down prod server...');
  if (IS_WIN) {
    // `next start` on Windows spawns worker subprocesses (router/SWC/etc.) —
    // a plain child.kill() leaves them orphaned. `taskkill /F /T` walks the
    // tree and force-kills the lot.
    try {
      await run('taskkill', ['/F', '/T', '/PID', String(server.pid)]);
    } catch (err) {
      console.warn('  ⚠  taskkill returned non-zero:', err.message);
    }
  } else {
    try {
      server.kill('SIGTERM');
      // ChildProcess.killed flips true the moment a signal is *sent*, not
      // when the process exits — so we can't use it to detect a stuck child.
      // Wait up to 2s for an actual 'exit' event; escalate to SIGKILL if the
      // server is still alive (exitCode null) after that.
      const exited = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000);
        server.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited && server.exitCode === null) server.kill('SIGKILL');
    } catch (err) {
      console.warn('  ⚠  kill failed:', err.message);
    }
  }
}

function installSignalHandlers() {
  // Both SIGINT (Ctrl+C) and uncaught failure paths must tear the server down.
  process.on('SIGINT', async () => {
    await killServer();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await killServer();
    process.exit(143);
  });
  process.on('exit', () => {
    // Best-effort sync kill on normal exit — async kill already ran upstream
    // in success/failure paths, this just covers process.exit() races.
    if (server && !shuttingDown) {
      try {
        server.kill();
      } catch {
        /* ignored */
      }
    }
  });
}

(async () => {
  installSignalHandlers();

  // Capture whether tsconfig.json was dirty BEFORE the build. If so, leave
  // it alone after build — auto-reverting would clobber the developer's
  // uncommitted edits. `git diff --quiet` exits 0 if clean, 1 if dirty.
  const tsconfigWasClean = spawnSync(
    'git',
    ['diff', '--quiet', '--', 'tsconfig.json'],
    { cwd: REPO_ROOT, stdio: 'ignore', shell: IS_WIN },
  ).status === 0;

  // The hybrid orchestrator runs this script twice against the same build (once
  // per data mode), so the second pass skips the ~5-minute rebuild. Only one
  // `next build` can hold the lock at a time, so this is also what keeps the
  // two passes from colliding.
  const skipBuild = process.env.MINDER_CAPTURE_SKIP_BUILD === '1';
  if (skipBuild) {
    console.log('\n→ MINDER_CAPTURE_SKIP_BUILD=1 — reusing the existing .next build.\n');
  } else {
    console.log(`\n→ Building Next.js (production)...\n`);
    await run('npm', ['run', 'build']);
  }

  // Next.js auto-injects `incremental: true` into tsconfig.json during build,
  // which this project deliberately dropped (see commit 0000f2f — stale
  // tsbuildinfo missed cross-file errors after a widened union). Revert it
  // so the orchestrator's working tree stays clean and a subsequent
  // `git commit` doesn't pick up Next.js's unwanted edit — but only when
  // tsconfig.json was clean before the build. If a developer had pending
  // edits, we don't touch the file (risk of clobbering their work) and
  // instead warn so they can manually strip the injection.
  if (tsconfigWasClean) {
    try {
      await run('git', ['checkout', 'HEAD', '--', 'tsconfig.json']);
    } catch (err) {
      console.warn('  ⚠  Could not revert tsconfig.json:', err.message);
    }
  } else {
    console.warn(
      '  ⚠  tsconfig.json had uncommitted edits before build — leaving as-is.\n' +
      '     Next.js may have appended `incremental: true` on top of your edits;\n' +
      '     review the diff and strip that line manually if present.',
    );
  }

  console.log(`\n→ Starting prod server on ${BASE}...\n`);
  // `shell: true` on Windows is required to spawn .cmd shims since Node 20.12
  // (CVE-2024-27980 / batch-file injection mitigation). The DEP0190 warning
  // about un-escaped args is acceptable here — args are hardcoded literals,
  // not user input.
  server = spawn(NEXT_BIN, ['start', '-p', String(PORT)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: IS_WIN,
    detached: false,
  });
  server.on('error', (err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });

  await waitForReady();

  // When this pass is meant to capture demo data, prove the flag actually took
  // before spending ~20 minutes on it. MINDER_DEMO is read by the server
  // process, not by the capture scripts, so a mis-plumbed env var fails silently
  // and would publish the real portfolio under the demo pass's filenames — the
  // one outcome the demo pass exists to prevent.
  if (process.env.MINDER_DEMO === '1') {
    await assertDemoFixturesLive();
  }

  console.log(`\n→ Server ready. Running captures against ${BASE}...\n`);

  const captureEnv = { ...process.env, MINDER_CAPTURE_BASE: BASE };
  try {
    await run('node', ['scripts/capture-screenshots.mjs'], { env: captureEnv });
    await run('node', ['scripts/capture-agents-skills.mjs'], { env: captureEnv });
    await run('node', ['scripts/capture-screenshots-extended.mjs'], { env: captureEnv });
    await run('node', ['scripts/capture-screenshots-deck.mjs'], { env: captureEnv });
  } finally {
    await killServer();
  }

  console.log('\n✓ Done. Captures written to site/screenshots/\n');
})().catch(async (err) => {
  console.error('\n✗ Capture run failed:', err.message);
  await killServer();
  process.exit(1);
});
