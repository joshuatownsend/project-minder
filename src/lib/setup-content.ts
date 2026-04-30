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
      "Durable backlog of intent. Survives sessions, gets reviewed in PRs, syncs across machines.",
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
      "Append-only checklist of manual steps the developer still needs to perform (Clerk setup, DNS changes, etc.). The append-only rule keeps merge conflicts trivial. On solo projects it's how you preserve setup state across machines; on teams it's how the next person sees what's pending.",
  },
] as const;

export const TRACKED_FILES_NOTE = `These are plain markdown — diffable, mergeable, and reviewable in pull requests. The biggest risk is **stashing** them mid-work: \`git stash pop\` can silently leave the stash in place on conflict, and a later \`git stash drop\` will permanently delete the changes. Eagerly commit these files to a small \`chore:\` commit instead of stashing them out of feature PRs.

For team projects, MANUAL_STEPS.md can occasionally surface machine-specific paths that one developer wrote but another shouldn't follow. The CLAUDE.md instructions above guard against that, but it's worth a brief skim during PR review.`;

export const CLAUDE_MD_TODO_BLOCK = `## TODO
- If I give you a TODO, save it to TODO.md in our repo.
- Consider our TODO list when planning new features. If something on the list can be accomplished during a plan or implement run, suggest it.
- Add TODO items if they make sense to do in the future, even if not part of the current plan you are creating.`;

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

…you MUST append an entry to \`MANUAL_STEPS.md\` in the project root.

#### Format

Use this exact structure (append, never overwrite):

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

1. **Append only** — never modify or delete existing entries in MANUAL_STEPS.md.
2. **One entry per session or feature** — group related steps under a single header.
3. **Be specific** — include exact commands, environment names, and documentation links.
4. **Indented detail lines** start with two or more spaces beneath the step they belong to.
5. **Create the file** if it does not already exist.
6. After appending, **tell me** that you've logged steps to MANUAL_STEPS.md and
   summarize what was added in one or two sentences.

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
