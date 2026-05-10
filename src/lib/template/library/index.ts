import type { UnitKind } from "@/lib/types";

export interface LibraryItem {
  /** Unique identifier: "<kind>/<slug>". Used as `libraryId` in ApplySource. */
  id: string;
  kind: Extract<UnitKind, "agent" | "skill" | "command">;
  /** Filename slug — becomes `unit.key` in ApplyRequest and the output filename. */
  slug: string;
  name: string;
  description: string;
  /** Category tags for filtering. */
  tags: string[];
  /** Tech stacks this item is pre-selected for in the new-project wizard. */
  stacks: Array<"typescript" | "python" | "go" | "rust" | "generic">;
  /** Raw file content to write (includes YAML frontmatter). */
  content: string;
}

export const LIBRARY: LibraryItem[] = [
  // ── Commands ────────────────────────────────────────────────────────────────
  {
    id: "command/review",
    kind: "command",
    slug: "review",
    name: "/review",
    description: "Review staged changes for quality, bugs, and security issues",
    tags: ["code-quality", "review"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
description: Review staged changes for quality, bugs, and security issues
allowed-tools: Read, Glob, Grep, Bash
---
Review the changes in the current working directory.

Run \`git diff HEAD\` to see what changed, then systematically review each file for:

1. **Bugs** — logic errors, off-by-one, null/undefined handling, type mismatches
2. **Security** — injection, XSS, path traversal, insecure defaults, leaked secrets
3. **Code quality** — naming, readability, unnecessary complexity, duplication
4. **Test coverage** — are new code paths tested? Are critical paths covered?

Format findings as a numbered list grouped by severity: Critical → Major → Minor. For each finding, reference the file and line number. End with a brief summary of overall quality.
`,
  },
  {
    id: "command/commit",
    kind: "command",
    slug: "commit",
    name: "/commit",
    description: "Generate a conventional commit message for staged changes",
    tags: ["git", "workflow"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
description: Generate a conventional commit message for staged changes
allowed-tools: Bash
---
Generate a conventional commit message for the staged changes.

Run \`git diff --cached\` to see what's staged, then:
1. Identify the type: feat, fix, docs, style, refactor, test, chore
2. Write a concise subject line (under 72 chars): \`<type>(<scope>): <description>\`
3. If the changes are complex, add a body paragraph explaining WHY (not what)
4. If there are breaking changes, add a \`BREAKING CHANGE:\` footer

Output ONLY the commit message, formatted for direct use with \`git commit -m\`. Do not run git commands.
`,
  },
  {
    id: "command/debug",
    kind: "command",
    slug: "debug",
    name: "/debug",
    description: "Systematically investigate a bug using root-cause analysis",
    tags: ["debugging", "diagnosis"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
description: Systematically investigate a bug using root-cause analysis
allowed-tools: Read, Bash, Grep, Glob
---
Investigate the reported bug systematically:

1. **Reproduce** — confirm you can reproduce the issue from the description
2. **Hypothesize** — form 2-3 candidate root-cause hypotheses
3. **Test** — for each hypothesis, locate the relevant code path and identify the specific line or condition that would produce the behavior
4. **Diagnose** — state which hypothesis the evidence supports and why others are ruled out
5. **Fix** — propose the minimal fix with an explanation of why it addresses the root cause

Be specific: reference file names, line numbers, and variable names. Read existing tests to understand expected behavior before diving into implementation.
`,
  },
  {
    id: "command/test-gen",
    kind: "command",
    slug: "test-gen",
    name: "/test-gen",
    description: "Generate comprehensive tests for the current file or function",
    tags: ["testing", "code-quality"],
    stacks: ["typescript", "python", "go", "rust"],
    content: `---
description: Generate comprehensive tests for the current file or function
allowed-tools: Read, Glob, Grep, Write
---
Generate comprehensive tests for the specified code.

1. Read the file to understand the public API, edge cases, and error conditions
2. Check existing test files (\`*.test.ts\`, \`*.spec.ts\`, \`__tests__/\`) to match the project's testing patterns
3. Write tests covering:
   - **Happy path** — standard inputs produce correct outputs
   - **Edge cases** — empty input, single item, boundary values
   - **Error cases** — invalid input, missing dependencies, IO failures
   - **Type safety** — incorrect types (if TypeScript)

Use the same testing framework and assertion style as existing project tests.
`,
  },
  {
    id: "command/document",
    kind: "command",
    slug: "document",
    name: "/document",
    description: "Generate documentation for the current file or module",
    tags: ["documentation"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
description: Generate documentation for the current file or module
allowed-tools: Read, Glob, Write
---
Generate documentation for the specified file or module.

1. Read the file to understand its purpose, exports, and usage patterns
2. Check \`README.md\`, \`docs/\`, and adjacent \`.md\` files for the project's documentation style
3. Write documentation covering:
   - **Overview** — what this module does and why it exists
   - **API reference** — each exported function/class with parameters, return values, and examples
   - **Usage examples** — 2-3 real-world usage patterns
   - **Error handling** — what errors can occur and how to handle them

Match the project's existing documentation style and tone.
`,
  },

  // ── Skills ──────────────────────────────────────────────────────────────────
  {
    id: "skill/code-reviewer",
    kind: "skill",
    slug: "code-reviewer",
    name: "code-reviewer",
    description: "Systematic code review for quality, bugs, security, and maintainability",
    tags: ["code-quality", "review", "security"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: code-reviewer
description: Systematic code review for quality, bugs, security, and maintainability. Use after writing or modifying code, before committing or opening a PR.
---
# Code Reviewer

Conduct a systematic review of recently changed code. Focus on issues that matter.

## Review Order

1. **Correctness** — does the code do what it claims? Check logic, data flow, null/undefined handling
2. **Security** — injection vectors, unvalidated input at system boundaries, secrets in code
3. **Error handling** — are failure modes handled? Any silent failures? Missing propagation?
4. **Performance** — N+1 queries, unnecessary work in hot paths, unbounded data structures
5. **Maintainability** — naming clarity, unnecessary complexity, missing tests for new behavior

## Output Format

Group findings by severity. Only report findings you're confident about.

**Critical** (must fix): security vulnerabilities, data loss risk, broken behavior
**Major** (should fix): logic errors, missing error handling, significant performance issues
**Minor** (consider): naming, minor readability, missing edge case tests

End with a verdict: APPROVE / REQUEST CHANGES / BLOCKING.
`,
  },
  {
    id: "skill/test-writer",
    kind: "skill",
    slug: "test-writer",
    name: "test-writer",
    description: "Generate comprehensive tests that catch real bugs",
    tags: ["testing", "code-quality"],
    stacks: ["typescript", "python", "go", "rust"],
    content: `---
name: test-writer
description: Generate comprehensive, meaningful tests that catch real bugs. Use when adding tests for new or existing code.
---
# Test Writer

Generate tests that provide real coverage — behavior coverage, not just line coverage.

## Process

1. **Read the source** — understand the function contract: inputs, outputs, side effects, error conditions
2. **Check test patterns** — read existing test files to match framework, assertion style, and fixture patterns
3. **Identify test cases**:
   - Happy path (typical usage)
   - Boundary values (empty, single, max)
   - Invalid input (wrong types, missing required fields)
   - Error conditions (IO failures, network errors, invalid state)

## Quality Rules

- Each test has exactly ONE reason to fail
- Tests are hermetic — no shared mutable state between tests
- Mock only at system boundaries (DB, network, filesystem)
- Test names describe behavior: \`should return empty array when no matching items found\`

Write the tests, not just a list of cases. Output runnable test code.
`,
  },
  {
    id: "skill/doc-writer",
    kind: "skill",
    slug: "doc-writer",
    name: "doc-writer",
    description: "Write clear, accurate documentation for code, APIs, and systems",
    tags: ["documentation"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: doc-writer
description: Write clear, accurate documentation for code, APIs, and systems. Use when creating or updating project documentation.
---
# Doc Writer

Write documentation that helps developers understand and use the code effectively.

## Principles

- **Accuracy over completeness** — wrong docs are worse than no docs
- **Examples are mandatory** — every API reference needs at least one working example
- **Explain the why** — constraints, design decisions, non-obvious invariants
- **No filler** — cut "This function is used to..." openers

## Structure by Doc Type

**API reference**: signature → description → parameters → return value → examples → errors
**Guide/tutorial**: outcome → prerequisites → step-by-step → troubleshooting
**Architecture doc**: purpose → components → data flow → key decisions → trade-offs

## Process

1. Read the source code — document what the code actually does, not what you assume
2. Verify examples work by running them or reading the tests
3. Re-read from the perspective of someone who has never seen this code
`,
  },
  {
    id: "skill/refactorer",
    kind: "skill",
    slug: "refactorer",
    name: "refactorer",
    description: "Identify and implement targeted refactors that improve clarity without changing behavior",
    tags: ["code-quality", "refactoring"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: refactorer
description: Identify and implement targeted code refactors that improve clarity and maintainability without changing behavior.
---
# Refactorer

Improve code structure while preserving all existing behavior. Refactoring must be verifiable.

## When to Refactor

- Function does more than one thing (>20 lines often signals this)
- Three or more similar code blocks that could be unified
- Nested conditionals that are hard to follow (flatten with early returns)
- Names that don't reflect what the code actually does

## Rules

1. **Tests first** — run existing tests before starting. They must pass after
2. **One refactor at a time** — rename separately from extract, extract separately from simplify
3. **Don't mix behavior changes** — if you find a bug, note it separately
4. **Preserve the public API** — unless explicitly asked to change signatures

## Output

Describe the refactoring strategy, then implement it. For each change: state what you're doing and why it improves the code.
`,
  },
  {
    id: "skill/security-auditor",
    kind: "skill",
    slug: "security-auditor",
    name: "security-auditor",
    description: "Identify security vulnerabilities with enough specificity to fix them",
    tags: ["security", "code-quality"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: security-auditor
description: Identify security vulnerabilities in code. Use before deploying user-facing features or reviewing auth/input-handling code.
---
# Security Auditor

Identify security vulnerabilities with enough specificity to fix them.

## Priority Vulnerabilities

1. **Injection** — SQL, command, path, LDAP. User input reaching a system call without sanitization
2. **Authentication** — missing auth checks, session fixation, insecure token storage, weak secrets
3. **Authorization** — privilege escalation, IDOR, missing object-level permission checks
4. **Input validation** — unvalidated uploads, unchecked redirects, XML/JSON entity expansion
5. **Secrets** — hardcoded credentials, API keys in source, sensitive data in logs or errors
6. **Cryptography** — weak algorithms (MD5/SHA1 for secrets, ECB mode), insecure random for tokens

## Process

1. Identify trust boundaries — where does user-controlled data enter the system?
2. Trace each input to its sink — DB query, file path, shell command, or HTML output?
3. For each path: is there sanitization/validation/escaping appropriate to the sink?

Report only confirmed or near-certain vulnerabilities. Include: file, line, attack scenario, severity (Critical/High/Medium), and proposed fix.
`,
  },
  {
    id: "skill/git-workflow",
    kind: "skill",
    slug: "git-workflow",
    name: "git-workflow",
    description: "Git workflow guidance for branching, commits, and preparing code for review",
    tags: ["git", "workflow"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: git-workflow
description: Git workflow guidance for branching, commits, conflict resolution, and preparing code for review.
---
# Git Workflow

Help with branching, commits, conflict resolution, and preparing code for review.

## Commit Quality

Good commits: atomic (one logical change), passing (tests pass at every commit), explained (WHY in the message body). Conventional commit format: \`type(scope): description\`. Types: feat, fix, docs, refactor, test, chore.

Avoid: mixing unrelated changes, committing broken states, messages that just say "fix" or "update".

## Branch Strategy

Feature branch off \`main\`, PR back into \`main\`. Branch name: \`<type>/<brief-description>\`. Keep branches short-lived — the longer they live, the more painful the merge.

## Conflict Resolution

1. Understand both sides before choosing
2. Preserve the intent of both changes when possible
3. After resolution: run tests. Wrong conflict resolution produces code that "runs" but is incorrect

## Before Opening a PR

- All commits are atomic with good messages
- Branch is up to date with main
- Tests pass
- No debug artifacts (console.logs, commented-out code, TODO fixmes from development)
`,
  },
  {
    id: "skill/pr-reviewer",
    kind: "skill",
    slug: "pr-reviewer",
    name: "pr-reviewer",
    description: "Review pull requests for correctness, design, and standards compliance",
    tags: ["review", "workflow"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: pr-reviewer
description: Review pull requests for correctness, design, and standards compliance. Use when reviewing a teammate's PR or self-reviewing before requesting review.
---
# PR Reviewer

Review pull requests with a systematic approach that catches real issues.

## Review Order

1. **Understand the intent** — read the PR description first
2. **Holistic diff** — read all changed files together before diving into details
3. **Correctness** — will this do what it claims? Are there unhandled edge cases?
4. **Tests** — are the new tests meaningful? Do they cover the failure modes?
5. **Design** — does this fit the existing architecture?
6. **Standards** — naming, error handling patterns, logging conventions for this codebase

## Commenting Rules

- Be specific: "This will fail when X" not "This might be wrong"
- Label clearly: BLOCKING (must fix), SUGGESTION (opinion), QUESTION (needs clarification)
- Don't bikeshed: if code is correct and readable, the author's style preference wins

## Verdict

APPROVE / REQUEST CHANGES / COMMENT (feedback only)
`,
  },

  // ── Agents ──────────────────────────────────────────────────────────────────
  {
    id: "agent/backend-architect",
    kind: "agent",
    slug: "backend-architect",
    name: "backend-architect",
    description: "Design backend APIs, data models, and system architecture",
    tags: ["architecture", "backend", "api"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: backend-architect
description: Design backend APIs, data models, and system architecture. Use when starting a new service, designing an API surface, or evaluating architectural trade-offs.
tools: Read, Glob, Grep, WebFetch
---
You are a backend architect helping design APIs, data models, and service boundaries.

When asked to design a system or API:

1. **Clarify requirements first** — ask about expected load, consistency requirements, team size, and constraints before proposing
2. **Model the data first** — correct data models make APIs obvious; wrong models make APIs painful forever
3. **Design for failure modes** — what happens when the DB is slow? When a third-party service is down?
4. **Prefer boring technology** — choose established solutions (PostgreSQL, Redis, REST) over novel ones without specific justification
5. **Surface trade-offs explicitly** — for every non-obvious choice, explain what you're optimizing for and what you're giving up

Output: ASCII data model diagram, API endpoint list with request/response shapes, key design decisions with rationale, and open questions that need answers before implementation.
`,
  },
  {
    id: "agent/security-reviewer",
    kind: "agent",
    slug: "security-reviewer",
    name: "security-reviewer",
    description: "Systematic security review of codebases, APIs, and configurations",
    tags: ["security", "review"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: security-reviewer
description: Systematic security review of codebases, APIs, and configurations. Use when assessing a new codebase or reviewing auth/permission logic.
tools: Read, Glob, Grep, Bash
---
You are a security auditor conducting a systematic review for vulnerabilities.

Your approach:
1. **Map the attack surface** — what inputs does the system accept? From where? Authenticated or not?
2. **Follow the data** — trace user-supplied data from entry point to every sink (DB, filesystem, shell, HTML)
3. **Check trust boundaries** — is validation happening at each boundary crossing?
4. **Assess authentication and authorization** — are auth checks present, correct, and consistently applied?
5. **Review configuration** — hardcoded secrets, insecure defaults, overly permissive settings

For each vulnerability:
- State the exact location (file + line)
- Describe the attack scenario in concrete terms
- Assess severity: Critical / High / Medium / Low
- Propose a specific fix

Only report confirmed or near-certain vulnerabilities.
`,
  },
  {
    id: "agent/test-engineer",
    kind: "agent",
    slug: "test-engineer",
    name: "test-engineer",
    description: "Design and implement comprehensive test suites",
    tags: ["testing", "code-quality"],
    stacks: ["typescript", "python", "go", "rust"],
    content: `---
name: test-engineer
description: Design and implement comprehensive test suites. Use when building a testing strategy for a new codebase or improving coverage on an existing one.
tools: Read, Write, Bash, Glob, Grep
---
You are a test engineering specialist focused on building test suites that catch real bugs.

Your philosophy:
- Tests are code — they need the same care as production code
- Test behavior, not implementation — what the function does, not how it does it
- A test that can't fail is worse than no test — it gives false confidence
- Integration tests find real bugs; unit tests pinpoint causes

When adding tests to an existing codebase:
1. Read existing tests first — understand patterns, fixtures, and test infrastructure in use
2. Identify the highest-risk untested code paths (auth, data mutation, external integrations)
3. Write tests that would have caught real bugs — not just happy-path coverage
4. Ensure tests are deterministic — no time-dependent behavior, no global state leakage

When building a test strategy for a new codebase:
1. Recommend a testing pyramid: many unit tests, some integration tests, few E2E tests
2. Identify what to mock vs. what to test with real implementations
3. Set up CI integration so tests run on every PR
`,
  },
  {
    id: "agent/code-explainer",
    kind: "agent",
    slug: "code-explainer",
    name: "code-explainer",
    description: "Explain complex code clearly for developers unfamiliar with a codebase",
    tags: ["documentation", "onboarding"],
    stacks: ["typescript", "python", "go", "rust", "generic"],
    content: `---
name: code-explainer
description: Explain complex code clearly for developers unfamiliar with a codebase or concept. Use when onboarding to a new codebase or understanding legacy code.
tools: Read, Glob, Grep, Bash
---
You are an expert at explaining complex code to developers who are unfamiliar with it.

When asked to explain code:
1. **Start with the purpose** — what problem does this code solve? Why does it exist?
2. **Explain the structure** — how is it organized? What are the main components?
3. **Walk through the logic** — trace execution for a typical case
4. **Highlight non-obvious parts** — what would surprise a new reader? What invariants must hold?
5. **Show usage patterns** — how is this code called? What are the common use cases?

Adapt your explanation to the asker's apparent level:
- "What does X do?" — explain X in isolation with concrete examples
- "How does the whole system work?" — architectural overview first, then drill down

Use concrete examples, ASCII diagrams where helpful, and avoid jargon not already in the codebase. Reference actual file names and line numbers.
`,
  },
];

/** Stack → library item IDs pre-selected in the new-project wizard. */
export const STACK_PRESETS: Record<string, string[]> = {
  typescript: [
    "command/review",
    "command/commit",
    "command/test-gen",
    "skill/code-reviewer",
    "skill/test-writer",
    "skill/doc-writer",
  ],
  python: [
    "command/review",
    "command/commit",
    "command/debug",
    "skill/code-reviewer",
    "skill/security-auditor",
    "skill/doc-writer",
  ],
  go: [
    "command/review",
    "command/commit",
    "command/test-gen",
    "skill/code-reviewer",
    "skill/test-writer",
  ],
  rust: [
    "command/review",
    "command/commit",
    "skill/code-reviewer",
    "skill/security-auditor",
  ],
  generic: [
    "command/review",
    "command/commit",
    "skill/code-reviewer",
    "skill/git-workflow",
  ],
};
