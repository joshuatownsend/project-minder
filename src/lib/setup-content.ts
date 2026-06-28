/**
 * Copy-paste content blocks for the Setup Guide page.
 * Extracted to keep SetupGuide.tsx focused on layout.
 */

/**
 * Recommended git treatment for the three project-level markdown files
 * Project Minder writes. Surfaced on the Setup page so users have a
 * single canonical answer to "should I commit these?"
 */
export const TRACKED_FILES = [
  {
    name: "TODO.md",
    treatment: "Commit",
    reason:
      "Durable, living backlog of intent — survives sessions, reviewed in PRs, syncs across machines. Keep it lean: completed or obsolete items move to `TODO.archive.md` (also committed), not deleted.",
  },
  {
    name: "INSIGHTS.md",
    treatment: "Commit",
    reason:
      "Codebase knowledge captured by Claude across sessions. Travels with the repo so every contributor benefits.",
  },
  {
    name: "MANUAL_STEPS.md",
    treatment: "Commit",
    reason:
      "Living checklist of manual steps the developer still needs to perform (Clerk setup, DNS changes, etc.). Keep it current — check off or prune done work; fully-completed entries move to `MANUAL_STEPS.archive.md` (also committed) so the active list shows only what's outstanding. On solo projects it's how you preserve setup state across machines; on teams it's how the next person sees what's pending.",
  },
] as const;

export const TRACKED_FILES_NOTE = `These are plain markdown — diffable, mergeable, and reviewable in pull requests. The biggest risk is **stashing** them mid-work: \`git stash pop\` can silently leave the stash in place on conflict, and a later \`git stash drop\` will permanently delete the changes. Eagerly commit these files to a small \`chore:\` commit instead of stashing them out of feature PRs. Completed work moves into companion \`*.archive.md\` files (e.g. \`TODO.archive.md\`, \`MANUAL_STEPS.archive.md\`) rather than being deleted — commit those too; Project Minder ignores them, so your active counts stay clean.

For team projects, MANUAL_STEPS.md can occasionally surface machine-specific paths that one developer wrote but another shouldn't follow. The CLAUDE.md instructions above guard against that, but it's worth a brief skim during PR review.`;

export const TRACKED_FILES_NOTE_PARAGRAPHS = TRACKED_FILES_NOTE.split("\n\n");

export const CLAUDE_MD_TODO_BLOCK = `## TODO
- If I give you a TODO, save it to \`TODO.md\` in our repo — the living checklist of outstanding work.
- Consider our TODO list when planning new features. If something on the list can be accomplished during a plan or implement run, suggest it.
- Add TODO items if they make sense to do in the future, even if not part of the current plan you are creating.
- **Keep it lean.** \`TODO.md\` shows only what's still outstanding. When an item is done or a newer plan makes it obsolete, move it out of \`TODO.md\` into \`TODO.archive.md\` (append it there with a completion date and a one-line "why") — don't leave finished work cluttering the active list, and don't silently delete it. Editing and pruning are expected; this is a checklist, not an append-only log.
- Don't remove an item you can't confirm is done or obsolete — surface the uncertainty to me instead.`;

export const CLAUDE_MD_MANUAL_STEPS_BLOCK = `## Manual Step Logging

Whenever you identify a step that I (the developer) must perform manually outside
of code — including but not limited to:

- Database migrations (Drizzle push, Prisma migrate deploy, etc.)
- External service setup (Clerk, Vercel, Stripe, Supabase, Resend, etc.)
- Environment variable configuration
- DNS or domain changes
- CLI commands that must be run in a specific environment
- Dashboard or UI actions in third-party services
- API key generation or rotation
- Deployment triggers or feature flag toggles

…you MUST record it in \`MANUAL_STEPS.md\` in the project root — the living checklist of manual actions the developer still needs to take.

#### Format

Use this structure (one dated entry per session or feature):

\`\`\`
## YYYY-MM-DD HH:MM | <project-or-feature-slug> | <plain-English context title>

- [ ] First step description
  Details, commands, or URLs on indented lines beneath the step
- [ ] Second step description
  \`example command --flag\`
  See: https://docs.example.com/relevant-page

---
\`\`\`

#### Rules

1. **Add** a dated entry (one header per session or feature) for new manual work; create the file if it doesn't exist.
2. **Keep it current.** Check off steps as they're done (\`- [x]\`). Once an entire entry is fully done or made obsolete by a newer plan, move that entry out of \`MANUAL_STEPS.md\` into \`MANUAL_STEPS.archive.md\` (append it there, adding a \`> archived YYYY-MM-DD — why\` note under the header) so the active file shows only outstanding work. This is a to-do list, not an append-only log — editing and pruning prior entries is expected.
3. **Don't remove or rewrite** a step you can't confirm is done or obsolete — surface the uncertainty to me instead.
4. **Be specific** — include exact commands, environment names, and documentation links.
5. **Indented detail lines** start with two or more spaces beneath the step they belong to.
6. **Format** — every list item is a \`- [ ]\` / \`- [x]\` checkbox, and every dated entry ends with a \`---\` separator.
7. After changing the file, **tell me** what you added, checked off, or archived in one or two sentences.
8. **Worktrees → canonical file.** If you're working inside a git worktree (a \`…--claude-worktrees-…\` directory), planning files are **project-scoped**, not branch-scoped: record manual steps — and \`TODO.md\` / \`INSIGHTS.md\` entries — in the **canonical main-tree** project (the parent checkout), never the worktree copy, so planning doesn't fragment into per-branch copies that are invisible until merge.

#### Example entry

\`\`\`
## 2026-03-17 14:32 | auth | Clerk + Vercel Authentication Setup

- [ ] Install Clerk package
  \`npm install @clerk/nextjs\`
- [ ] Add environment variables to Vercel dashboard
  CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  See: https://clerk.com/docs/deployments/deploy-to-vercel
- [ ] Wrap root layout with <ClerkProvider> in app/layout.tsx
- [ ] Add middleware.ts to protect routes
  See: https://clerk.com/docs/references/nextjs/auth-middleware

---
\`\`\``;

export const HOOKS_SETTINGS_SNIPPET = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/validate-todo-format.mjs\\""
          },
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/validate-manual-steps.mjs\\""
          }
        ]
      }
    ]
  }
}`;

export const HOOKS_VALIDATE_TODO = `#!/usr/bin/env node
/**
 * PreToolUse hook: validates that TODO.md only uses - [ ] / - [x] checkboxes,
 * never bare "- " list items. Fires on Write and Edit targeting TODO.md.
 */
import { readFileSync, existsSync } from 'fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolName = input.tool_name;
const toolInput = input.tool_input;

// Only care about TODO.md
const filePath = toolInput?.file_path ?? '';
const normalizedPath = filePath.replace(/\\\\/g, '/');
if (!normalizedPath.endsWith('/TODO.md') && normalizedPath !== 'TODO.md') {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// Get the content to validate
let content = '';
if (toolName === 'Write') {
  content = toolInput.content ?? '';
} else if (toolName === 'Edit') {
  try {
    const currentContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    const oldStr = toolInput.old_string ?? '';
    const newStr = toolInput.new_string ?? '';
    if (oldStr && currentContent.includes(oldStr)) {
      content = currentContent.replace(oldStr, newStr);
    } else {
      content = newStr;
    }
  } catch {
    content = toolInput.new_string ?? '';
  }
} else {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

const lines = content.split('\\n');
const errors = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Match bare "- " list items that are NOT checkboxes and NOT indented sub-detail
  // Allow: "- [ ] text", "- [x] text", "  detail lines", "# headings", blank lines
  const bareListMatch = line.match(/^- (?!\\[[ x]\\] )/);
  if (bareListMatch) {
    errors.push(\`Line \${i + 1}: "\${line.substring(0, 60)}..." — use "- [ ] " or "- [x] " checkbox format\`);
  }
}

if (errors.length > 0) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: \`TODO.md format violation: all list items must use "- [ ]" or "- [x]" checkbox syntax.\\n\${errors.join('\\n')}\`
  }));
} else {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
}`;

export const HOOKS_VALIDATE_MANUAL_STEPS = `#!/usr/bin/env node
/**
 * PreToolUse hook: validates that MANUAL_STEPS.md follows the required format
 * when written or edited. Enforces:
 * - Section headers use ## YYYY-MM-DD [HH:MM] | slug | title
 * - List items use - [ ] checkbox syntax
 * - Each entry (header + items) ends with a --- separator
 */
import { readFileSync, existsSync } from 'fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolName = input.tool_name;
const toolInput = input.tool_input;

// Only care about MANUAL_STEPS.md
const filePath = toolInput?.file_path ?? '';
const normalizedPath = filePath.replace(/\\\\/g, '/');
if (!normalizedPath.endsWith('/MANUAL_STEPS.md') && normalizedPath !== 'MANUAL_STEPS.md') {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

// For Write, validate the full content directly.
// For Edit, read the current file and validate the full result.
let content = '';
if (toolName === 'Write') {
  content = toolInput.content ?? '';
} else if (toolName === 'Edit') {
  try {
    const currentContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    const oldStr = toolInput.old_string ?? '';
    const newStr = toolInput.new_string ?? '';
    if (oldStr && currentContent.includes(oldStr)) {
      content = currentContent.replace(oldStr, newStr);
    } else {
      content = newStr;
    }
  } catch {
    content = toolInput.new_string ?? '';
  }
} else {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

const lines = content.split('\\n');
const errors = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Check that list items use checkbox syntax
  if (line.match(/^- /) && line.trim() !== '---') {
    if (!line.match(/^- \\[[ x]\\] /)) {
      errors.push(\`Line \${i + 1}: "\${line.substring(0, 60)}" — use "- [ ] " or "- [x] " checkbox format\`);
    }
  }

  // Check that ## headers follow date [time] | slug | title pattern
  if (line.startsWith('## ') && !line.startsWith('## ----')) {
    const headerPattern = /^## \\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2})? \\| .+ \\| .+/;
    if (!headerPattern.test(line)) {
      errors.push(\`Line \${i + 1}: Header "\${line.substring(0, 60)}" — must follow "## YYYY-MM-DD [HH:MM] | slug | title" format\`);
    }
  }
}

// Enforce that the last non-empty line is --- (final entry must be closed)
const trimmedLines = lines.map(l => l.trim()).filter(l => l.length > 0);
if (trimmedLines.length > 0) {
  const lastLine = trimmedLines[trimmedLines.length - 1];
  const hasHeaders = trimmedLines.some(l => /^## \\d{4}-\\d{2}-\\d{2}/.test(l));
  if (hasHeaders && lastLine !== '---') {
    errors.push('File must end with a "---" separator after the last entry');
  }
}

if (errors.length > 0) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: \`MANUAL_STEPS.md format violation:\\n\${errors.join('\\n')}\`
  }));
} else {
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
}`;
