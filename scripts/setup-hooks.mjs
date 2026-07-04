#!/usr/bin/env node
/**
 * Writes the canonical pre-commit hook to .git/hooks/pre-commit.
 * Run with: pnpm setup-hooks
 * Idempotent: no-op when the hook already matches.
 */

import { readFileSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HOOK_CONTENT = `#!/bin/sh
# Run lint, type-check, and tests before committing (lint first — fastest to fail)
pnpm lint && pnpm typecheck && pnpm test --pool=forks
`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const DEFAULT_HOOK_PATH = resolve(repoRoot, '.git', 'hooks', 'pre-commit');

export function setupHooks({ hookPath = DEFAULT_HOOK_PATH, dryRun = false } = {}) {
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;

  if (existing === HOOK_CONTENT) {
    console.log(`pre-commit hook already up to date at ${hookPath}`);
    return { written: false, path: hookPath };
  }

  if (!dryRun) {
    writeFileSync(hookPath, HOOK_CONTENT, 'utf8');
    try {
      chmodSync(hookPath, 0o755);
    } catch {
      // chmod is a no-op on Windows — Git for Windows and WSL will still execute the hook
    }
    const action = existing ? 'Updated' : 'Installed';
    console.log(`${action} pre-commit hook at ${hookPath}`);
  }

  return { written: true, path: hookPath };
}

// Only execute when run directly (not when imported by tests)
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  setupHooks();
}
