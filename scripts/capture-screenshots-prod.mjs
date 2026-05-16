// Builds Next.js for production, starts `next start` on a side-port, polls
// until ready, runs the three capture scripts against it, then tears down.
//
// Why prod over dev for captures: Next.js dev recompiles routes lazily on
// each visit and emits a "Compiling…" pill, and dev data fetches are much
// slower (e.g. /api/usage aggregating 4400+ sessions takes ~19s in dev vs
// ~1s in prod). The 2026-05-16 docs refresh shipped with one residual
// skeleton frame in /usage as a result; this script eliminates that whole
// category of flake.

import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PORT = Number(process.env.MINDER_CAPTURE_PORT) || 4101;
const BASE = `http://localhost:${PORT}`;
const IS_WIN = process.platform === 'win32';
const NEXT_BIN = join(REPO_ROOT, 'node_modules', '.bin', IS_WIN ? 'next.cmd' : 'next');
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;

// Hold the server reference so signal handlers can kill it.
let server = null;
let shuttingDown = false;

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
      // Give it 2s to shut down gracefully, then SIGKILL
      await delay(2_000);
      if (!server.killed) server.kill('SIGKILL');
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

  console.log(`\n→ Building Next.js (production)...\n`);
  await run('npm', ['run', 'build']);

  // Next.js auto-injects `incremental: true` into tsconfig.json during build,
  // which this project deliberately dropped (see commit 0000f2f — stale
  // tsbuildinfo missed cross-file errors after a widened union). Revert it
  // so the orchestrator's working tree stays clean and a subsequent
  // `git commit` doesn't pick up Next.js's unwanted edit.
  try {
    await run('git', ['checkout', 'HEAD', '--', 'tsconfig.json']);
  } catch (err) {
    console.warn('  ⚠  Could not revert tsconfig.json:', err.message);
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
  console.log(`\n→ Server ready. Running captures against ${BASE}...\n`);

  const captureEnv = { ...process.env, MINDER_CAPTURE_BASE: BASE };
  try {
    await run('node', ['scripts/capture-screenshots.mjs'], { env: captureEnv });
    await run('node', ['scripts/capture-agents-skills.mjs'], { env: captureEnv });
    await run('node', ['scripts/capture-screenshots-extended.mjs'], { env: captureEnv });
  } finally {
    await killServer();
  }

  console.log('\n✓ Done. Captures written to site/screenshots/\n');
})().catch(async (err) => {
  console.error('\n✗ Capture run failed:', err.message);
  await killServer();
  process.exit(1);
});
