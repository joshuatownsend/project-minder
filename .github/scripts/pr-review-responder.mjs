#!/usr/bin/env node
// Autonomous PR review responder — invoked by .github/workflows/pr-review-responder.yml
// Flow: fetch unresolved threads → classify P0/P1/P2 → fix P0/P1 → check → commit → reply
//       on failure: debug loop up to MAX_DEBUG_PASSES, then escalate

import { spawnSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_DEBUG_PASSES = 3;
const CLAUDE_TIMEOUT_MS = 240_000;
const { ANTHROPIC_API_KEY, PR_NUMBER, GITHUB_REPOSITORY } = process.env;

if (!ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY not set');
if (!PR_NUMBER)          die('PR_NUMBER not set');
if (!GITHUB_REPOSITORY)  die('GITHUB_REPOSITORY not set');

const [OWNER, REPO] = GITHUB_REPOSITORY.split('/');

// Paths Claude Code must never modify — CI config integrity guardrail
const PROTECTED = ['.github/workflows/', '.github/actions/', '.github/scripts/'];

// CI check order matches .github/workflows/ci.yml exactly
const CI_CHECKS = ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build'];

// ── Low-level helpers ─────────────────────────────────────────────────────────

function die(msg) {
  console.error(`\n💀 ${msg}`);
  process.exit(1);
}

/**
 * Run a git/shell command with explicit arg array (no shell injection risk).
 * For internal commands only — never pass user-controlled PR content here.
 */
function git(...args) {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** Run `claude -p <prompt>` in headless mode with permissions bypassed for CI. */
function claudeCode(prompt) {
  const result = spawnSync(
    'claude',
    ['-p', prompt, '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6'],
    {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLAUDE_TIMEOUT_MS,
      cwd: process.cwd(),
      env: process.env,
    }
  );
  if (result.status !== 0) {
    console.warn(`  ⚠ claude exited ${result.status}: ${(result.stderr || '').slice(0, 400)}`);
  }
  return result;
}

/** Direct Anthropic API call — no SDK dep, uses Haiku for lightweight classification. */
async function callAnthropic(prompt, model = 'claude-haiku-4-5-20251001', maxTokens = 300) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) die(`Anthropic API ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).content[0].text;
}

/** Thin wrapper around `gh api` with JSON body piped via stdin. */
function ghApi(args, body) {
  const result = spawnSync('gh', args, {
    input: body ? JSON.stringify(body) : undefined,
    encoding: 'utf-8',
    stdio: body ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} → ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function postPRComment(body) {
  spawnSync('gh', ['pr', 'comment', PR_NUMBER, '--body', body],
    { encoding: 'utf-8', env: process.env });
}

// ── PR data (GraphQL for databaseId) ─────────────────────────────────────────

function fetchPRData() {
  // REST `gh pr view --json` doesn't always populate comment.databaseId (integer),
  // which is required by POST /pulls/{n}/comments in_reply_to. Use GraphQL directly.
  const query = `
    query($owner:String!, $repo:String!, $pr:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          headRefName
          headRepository { nameWithOwner }
          reviewThreads(first:50) {
            nodes {
              id
              isResolved
              isOutdated
              comments(first:5) {
                nodes {
                  id
                  databaseId
                  path
                  line
                  originalLine
                  body
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = spawnSync('gh', [
    'api', 'graphql',
    '-f', `query=${query}`,
    '-f', `owner=${OWNER}`,
    '-f', `repo=${REPO}`,
    '-F', `pr=${PR_NUMBER}`,
  ], { encoding: 'utf-8', env: process.env });

  if (result.status !== 0) die(`GraphQL fetch failed: ${result.stderr}`);
  return JSON.parse(result.stdout).data.repository.pullRequest;
}

function getUnresolvedThreads(pr) {
  return (pr.reviewThreads?.nodes || []).filter(
    t => !t.isResolved && !t.isOutdated && t.comments.nodes.length > 0
  );
}

// ── Classification ────────────────────────────────────────────────────────────

async function classifyComments(threads) {
  const results = [];

  for (const thread of threads) {
    const comment = thread.comments.nodes[0];

    const text = await callAnthropic(`Classify this GitHub PR review comment. Reply with JSON only — no prose.

File: ${comment.path || 'N/A'}
Line: ${comment.originalLine || comment.line || 'N/A'}
Comment: "${(comment.body || '').slice(0, 600)}"

Priority levels:
- P0: Bug, security flaw, data loss risk, or broken correctness
- P1: Performance issue, best-practice violation, or significant maintainability problem
- P2: Style nit, naming preference, minor formatting, or optional suggestion

Reply: {"priority":"P0"|"P1"|"P2","rationale":"one sentence"}`);

    let priority = 'P1';
    let rationale = 'Defaulted to P1 (classification parse failed)';

    try {
      const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
      if (['P0', 'P1', 'P2'].includes(parsed.priority)) {
        priority = parsed.priority;
        rationale = parsed.rationale || '';
      }
    } catch (e) {
      console.warn(`  Classification parse failed for thread ${thread.id}: ${e.message}`);
    }

    results.push({
      thread,
      comment,
      threadId: thread.id,
      databaseId: comment.databaseId,
      file: comment.path || '',
      line: comment.originalLine || comment.line || 0,
      body: comment.body || '',
      priority,
      rationale,
    });
  }

  return results;
}

// ── Fix prompts ───────────────────────────────────────────────────────────────

function buildFixPrompt(item) {
  let excerpt = '';
  if (item.file && existsSync(item.file)) {
    const lines = readFileSync(item.file, 'utf-8').split('\n');
    const ln = Number(item.line);
    const s = Math.max(0, ln - 15);
    const e = Math.min(lines.length, ln + 15);
    excerpt = lines.slice(s, e)
      .map((l, i) => `${s + i + 1}${s + i + 1 === ln ? '◄' : ' '} ${l}`)
      .join('\n');
  }

  return `You are a PR review bot. Fix ONLY the issue below. Do not refactor, rename, or modify anything else.

[${item.priority}] ${item.file}:${item.line}
Review comment: "${item.body}"
Why this matters: ${item.rationale}

${excerpt ? `Code context:\n\`\`\`\n${excerpt}\n\`\`\`` : ''}

Steps:
1. Read the file if you need more context
2. Make the minimal targeted change to address the review comment
3. Save the file
4. NEVER modify any file under .github/ — hard guardrail`;
}

function buildDebugPrompt(checkResult, pass) {
  return `You are fixing a CI failure after auto-applying PR review fixes. This is debug pass ${pass}.

Failed command: ${checkResult.failedCmd}
Output:
\`\`\`
${checkResult.output.slice(0, 4000)}
\`\`\`

Instructions:
- Read failing source files for context
- Make targeted corrections to resolve the failure
- Do NOT touch any .github/ files or CI configuration
- Do NOT make broad refactors — fix only what broke`;
}

// ── Guardrails ────────────────────────────────────────────────────────────────

function getModifiedFiles() {
  try {
    return git('diff', '--name-only', 'HEAD').trim().split('\n').filter(Boolean);
  } catch { return []; }
}

/**
 * Reverts any modifications to protected CI config paths.
 * Returns true if a violation was found and reverted.
 */
function enforceCIGuardrail() {
  const modified = getModifiedFiles();
  const violations = modified.filter(f => PROTECTED.some(p => f.startsWith(p)));
  if (violations.length === 0) return false;
  console.warn(`  🛡  Reverting unauthorized CI-config changes: ${violations.join(', ')}`);
  spawnSync('git', ['checkout', '--', '.github/'],
    { encoding: 'utf-8', stdio: 'pipe', env: process.env });
  return true;
}

// ── Check runner ──────────────────────────────────────────────────────────────

function runChecks() {
  let allOutput = '';

  for (const cmd of CI_CHECKS) {
    process.stdout.write(`  ${cmd} ... `);
    const [exe, ...args] = cmd.split(/\s+/);
    const result = spawnSync(exe, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      shell: false,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    allOutput += `$ ${cmd}\n${result.stdout || ''}${result.stderr || ''}\n\n`;

    if (result.status !== 0) {
      console.log('✗');
      return { success: false, output: allOutput.slice(0, 8000), failedCmd: cmd };
    }
    console.log('✓');
  }

  return { success: true, output: allOutput };
}

// ── Commit & push ─────────────────────────────────────────────────────────────

function commitAndPush(actionable) {
  spawnSync('git', ['add', '-A'],
    { encoding: 'utf-8', stdio: 'pipe', env: process.env });
  // Belt-and-suspenders: unstage any .github/ files
  spawnSync('git', ['restore', '--staged', '.github/'],
    { encoding: 'utf-8', stdio: 'pipe', env: process.env });

  const staged = git('diff', '--cached', '--name-only').trim();
  if (!staged) {
    console.log('  Nothing to commit (no files changed after guardrail).');
    return null;
  }

  const refs = actionable
    .map(i => `  [${i.priority}] ${i.file}:${i.line} — ${i.rationale}`)
    .join('\n');
  const msg = `fix(pr-review): address ${actionable.length} comment(s) on PR #${PR_NUMBER}\n\nAddressed:\n${refs}\n\nAutomated fix by PR Review Responder.`;

  // Write to temp file — avoids any shell escaping issues with special chars in rationale
  const msgFile = join(tmpdir(), `pr-bot-${Date.now()}.txt`);
  writeFileSync(msgFile, msg, 'utf-8');
  spawnSync('git', ['commit', '-F', msgFile],
    { encoding: 'utf-8', stdio: 'inherit', env: process.env });

  const sha = git('rev-parse', '--short', 'HEAD').trim();
  // NEVER --force — hard guardrail against overwriting shared history
  const pushResult = spawnSync('git', ['push'],
    { encoding: 'utf-8', stdio: 'inherit', env: process.env });
  if (pushResult.status !== 0) {
    throw new Error(`git push failed with exit code ${pushResult.status ?? 'null'}`);
  }
  console.log(`  Pushed ${sha}`);
  return sha;
}

// ── Thread replies ────────────────────────────────────────────────────────────

function replyToThread(item, sha) {
  if (!item.databaseId) {
    console.warn(`  No databaseId for ${item.file}:${item.line} — skipping reply`);
    return;
  }
  const body = sha
    ? `Fixed in ${sha} · **${item.priority}**: ${item.rationale}`
    : `Auto-fix attempted but push failed · **${item.priority}**: ${item.rationale}`;
  try {
    ghApi(
      ['api', `repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments`,
       '--method', 'POST', '--input', '-'],
      { body, in_reply_to: item.databaseId }
    );
  } catch (e) {
    console.warn(`  Reply to ${item.databaseId} failed: ${e.message}`);
  }
}

function resolveThread(threadId) {
  const mutation = `mutation{resolveReviewThread(input:{threadId:"${threadId}"}){thread{isResolved}}}`;
  spawnSync('gh', ['api', 'graphql', '-f', `query=${mutation}`],
    { encoding: 'utf-8', env: process.env });
}

// ── Comment builders ──────────────────────────────────────────────────────────

function commentTable(items) {
  const rows = items.map(i =>
    `| ${i.priority} | \`${i.file}:${i.line}\` | ${i.body.slice(0, 80).replace(/\|/g, '\\|')} | ${i.rationale} |`
  ).join('\n');
  return `| Priority | Location | Comment | Rationale |\n|----------|----------|---------|----------|\n${rows}`;
}

function escalationComment(actionable, p2, failure) {
  return [
    '## ❌ PR Review Responder — Escalation',
    '',
    `Automated fix failed after ${MAX_DEBUG_PASSES} debug pass(es). Manual review required.`,
    '',
    '### Last failing check',
    '```',
    (failure?.output || '').slice(0, 3500),
    '```',
    '',
    '### Comments requiring attention',
    commentTable([...actionable, ...p2]),
  ].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖  PR Review Responder — PR #${PR_NUMBER} @ ${GITHUB_REPOSITORY}\n`);

  // ── Fetch PR ──────────────────────────────────────────────────────────────
  const pr = fetchPRData();
  console.log(`Branch: ${pr.headRefName}`);

  // Block fork PRs — GITHUB_TOKEN cannot push to forks
  if (pr.headRepository?.nameWithOwner !== GITHUB_REPOSITORY) {
    postPRComment('⚠️ **PR Review Responder**: Cannot auto-fix fork PRs (no push access). Please apply fixes manually.');
    return;
  }

  // ── Get unresolved threads ────────────────────────────────────────────────
  const threads = getUnresolvedThreads(pr);
  if (threads.length === 0) {
    console.log('No unresolved review threads — nothing to do.');
    return;
  }
  console.log(`${threads.length} unresolved thread(s).\n`);

  // ── Classify ──────────────────────────────────────────────────────────────
  console.log('Classifying comments (Haiku)...');
  const classified = await classifyComments(threads);

  const p0p1 = classified
    .filter(c => c.priority !== 'P2')
    .sort((a, b) => (a.priority === 'P0' ? -1 : b.priority === 'P0' ? 1 : 0));
  const p2 = classified.filter(c => c.priority === 'P2');

  classified.forEach(c => console.log(`  [${c.priority}] ${c.file}:${c.line} — ${c.rationale}`));

  if (p0p1.length === 0) {
    postPRComment(
      '## ℹ️ PR Review Responder\n\nAll comments classified as **P2** (stylistic/optional). No automated fixes applied.\n\n' +
      p2.map(c => `- \`${c.file}:${c.line}\` — ${c.rationale}`).join('\n')
    );
    return;
  }

  // ── Apply fixes once ──────────────────────────────────────────────────────
  console.log('\nApplying fixes (Sonnet)...');
  for (const item of p0p1) {
    console.log(`\n  [${item.priority}] ${item.file}:${item.line}`);
    claudeCode(buildFixPrompt(item));
    // Guard immediately after each fix to catch stray .github/ writes
    enforceCIGuardrail();
  }

  // Early-out: if guardrail reverted everything and no files changed, escalate
  if (getModifiedFiles().length === 0) {
    postPRComment(
      '⚠️ **PR Review Responder**: Fixes produced no file changes (or all were blocked by CI-config guardrail). Manual review required.\n\n' +
      commentTable(p0p1)
    );
    return;
  }

  // ── Check → debug loop ────────────────────────────────────────────────────
  // Fixes are applied once above. Debug patches accumulate across passes — no reset between
  // passes because the debug patch from pass N is meant to carry forward into pass N+1.
  let lastFailure = null;

  for (let pass = 1; pass <= MAX_DEBUG_PASSES; pass++) {
    console.log(`\nCheck pass ${pass}/${MAX_DEBUG_PASSES}...`);
    const result = runChecks();

    if (result.success) {
      // ── Green — commit, push, reply ──────────────────────────────────────
      console.log('\nAll checks passed. Committing...');
      const sha = commitAndPush(p0p1);

      console.log('Replying to threads...');
      for (const item of p0p1) {
        replyToThread(item, sha);
        resolveThread(item.threadId);
      }

      if (p2.length > 0) {
        postPRComment(
          `## ✅ PR Review Responder${sha ? ` — fixed in \`${sha}\`` : ''}\n\n` +
          `P2 comments classified as stylistic — not auto-fixed:\n\n` +
          p2.map(c => `- \`${c.file}:${c.line}\` — ${c.rationale}`).join('\n')
        );
      }

      console.log(`\n✅ Done — ${p0p1.length} comment(s) addressed${sha ? ` in ${sha}` : ''}.`);
      return;
    }

    // ── Red — debug or escalate ───────────────────────────────────────────
    lastFailure = result;
    console.log(`\n  ✗ ${result.failedCmd} failed on pass ${pass}`);

    if (pass < MAX_DEBUG_PASSES) {
      console.log('  Invoking Claude Code to debug...');
      claudeCode(buildDebugPrompt(result, pass));
      enforceCIGuardrail(); // guard after debug patch too
    }
  }

  // ── Escalate ──────────────────────────────────────────────────────────────
  console.log('\n🚨 Escalating after max debug passes...');
  postPRComment(escalationComment(p0p1, p2, lastFailure));

  // Leave workspace clean for any follow-up manual work
  spawnSync('git', ['checkout', '.'], { stdio: 'pipe', env: process.env });
  spawnSync('git', ['clean', '-fd'], { stdio: 'pipe', env: process.env });

  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
