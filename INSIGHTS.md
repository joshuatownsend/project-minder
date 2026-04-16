# Insights

<!-- insight:30ab4fef8e43 | session:661056b7-befa-4f76-81c0-03159b90270a | 2026-04-16T19:52:15.694Z -->
## ★ Insight
The toggle uses **optimistic opacity** (`opacity: 0.5` while in-flight) rather than optimistic state because the server returns the authoritative post-write `TodoInfo` — simpler and avoids a stale-state bug if the write fails.

---
<!-- insight:89dca674735f | session:661056b7-befa-4f76-81c0-03159b90270a | 2026-04-16T19:49:44.171Z -->
## ★ Insight
The ManualSteps toggle works because `parseManualStepsMd` stores line numbers per item. `scanTodoMd` discards line numbers entirely — so even if we had a toggle API, we'd have no way to know which line to mutate. The fix threads line numbers through all 5 layers: type → scanner → writer → API route → UI.

---

<!-- insight:bcab28f3eca7 | session:661056b7-befa-4f76-81c0-03159b90270a | 2026-04-16T19:49:12.063Z -->
## ★ Insight
The `Circle` and `CheckCircle2` icons in `TodoList.tsx` have no `onClick` handler — they're purely decorative. The `ManualStepsList` component (for Manual Steps) has toggle support, but that pattern was never wired up for TODOs.

---


<!-- insight:e8c2db7d4c57 | session:7ed31474-191f-4cc4-a499-f22c78d4fea8 | 2026-04-16T19:33:09.855Z -->
## ★ Insight
This is the classic Windows-to-Linux CI failure pattern: `path.basename` on Linux only splits on `/`, not `\`. The project already has a `platform.ts` module for cross-platform concerns, but path manipulation using Node's built-in `path` module silently breaks when Windows-style paths are fed into Linux's POSIX `path.basename`. The regex split `/[/\\]/` is the idiomatic cross-platform fix for last-segment extraction.

---

<!-- insight:57d77ed13551 | session:7ed31474-191f-4cc4-a499-f22c78d4fea8 | 2026-04-16T19:26:02.429Z -->
## ★ Insight
ESLint 9 switched from `.eslintrc.*` (legacy config) to `eslint.config.js` (flat config) as the default. Next.js 16 ships `eslint-config-next` but doesn't auto-generate the config file for existing projects — you have to add it. The `FlatCompat` wrapper is the bridge that lets old-style `extends: ["next/core-web-vitals"]` rules work inside the new flat config format, without having to rewrite every rule in native flat-config syntax.

---

<!-- insight:7d70318c27d9 | session:7ed31474-191f-4cc4-a499-f22c78d4fea8 | 2026-04-16T19:17:20.240Z -->
## ★ Insight
The `ci.yml` uses `npm ci` (not `npm install`) intentionally — `npm ci` uses `package-lock.json` exactly, fails if it's out of date, and never modifies it. This gives CI a deterministic, reproducible install that catches "works on my machine because my node_modules is different" problems. The `cache: 'npm'` in `setup-node` caches the npm cache folder between runs, so `npm ci` is fast after the first run.

---

<!-- insight:c772b44a6809 | session:7ed31474-191f-4cc4-a499-f22c78d4fea8 | 2026-04-16T19:03:32.929Z -->
## ★ Insight
Two things worth knowing about this plan's structure: (1) Phase A is intentionally "no dependencies" — you can apply it today even if CI never lands, because force-push/deletion/linear-history rules don't depend on any status check. (2) The maintainer bypass set to "Always" is the solo-dev escape hatch — without it, a rule like "require PR" would mean you can't hotfix `main` from your laptop at 2am. GitHub's bypass model is the right place to encode "I trust myself, but I want the guardrails to catch accidents."

---

<!-- insight:cb7bf19c791b | session:7ed31474-191f-4cc4-a499-f22c78d4fea8 | 2026-04-16T19:02:11.046Z -->
## ★ Insight
One subtle benefit of squash + linear history + PR-required on a solo repo: it converts your ad-hoc `Merge branch 'main' of ...` commits (caused by `git pull` without rebase) into a clean one-PR-per-feature log. Your recent history already shows both styles mixed — enforcing squash now means new readers of the public repo see a tidy story, not "what was this local merge for?"

---

<!-- insight:fc11572a090f | session:7ed31474-191f-4cc4-a499-f22c78d4fea8 | 2026-04-16T18:37:39.335Z -->
## ★ Insight
Branch protection rules on a solo-maintainer public repo are a different design problem than on a team repo. Team repos use them to enforce review between people; solo repos use them as a safety net against your own mistakes (accidental force-push, deleting main, bypassing your own tests). The rule set should match that threat model — not copy-paste from enterprise playbooks.

---

<!-- insight:953fe4cd64c3 | session:03581b67-1dea-4628-8be9-0134803f87b0 | 2026-04-16T18:06:33.616Z -->
## ★ Insight
The temp-dir approach (`mkdtemp` + `afterEach rm`) is preferable to `vi.mock("fs")` here because `setupApply.ts`'s value proposition *is* the file layout it produces — idempotency, backup creation, partial merges. Mocking `fs` would test that `writeFile` was called; the real filesystem tests that the resulting files are correct. The `afterEach` cleanup ensures tests are hermetic even if one throws mid-way.

---

<!-- insight:2c17cdd32cb8 | session:03581b67-1dea-4628-8be9-0134803f87b0 | 2026-04-16T18:04:25.964Z -->
## ★ Insight
`setupApply.ts` uses real `fs.promises` rather than injected deps, so tests need **real temp directories** instead of `vi.mock("fs")`. `os.tmpdir()` + `fs.mkdtemp` gives each test an isolated scratch dir, and `afterEach` cleans up. This is better than mocking for filesystem-heavy logic because the test exercises the actual file layout — a mock would only prove the code called write functions, not that the resulting files are correct.

---

<!-- insight:20b5f762ac12 | session:03581b67-1dea-4628-8be9-0134803f87b0 | 2026-04-16T18:03:27.577Z -->
## ★ Insight
`setupApply.ts` uses **real `fs` calls** (not injected), which means tests need to use `tmp` directories rather than `vi.mock("fs")`. This is a different testing pattern from the rest of the codebase — but it's actually better for these tests because the logic we care about is the *file layout* after apply, not just the parsing logic. Temp-dir fixtures let the real filesystem validate the idempotency contract.

---

<!-- insight:edcacf1e497f | session:177aee6d-5c58-4038-9422-d242d4bf0a9c | 2026-04-16T16:50:09.861Z -->
## ★ Insight
The `vi.mock("child_process")` call must be at the **top of the file** because Vitest hoists it before any imports during transformation — if you put it inside a `describe` block or `beforeEach`, the mock won't be in place when the real module is first imported. The `vi.mocked()` wrapper then lets you configure return values inside individual tests after the mock factory has already run.

---

<!-- insight:2c78c9bf8db4 | session:177aee6d-5c58-4038-9422-d242d4bf0a9c | 2026-04-16T16:47:39.050Z -->
## ★ Insight
The `vi.mock("child_process")` approach for testing spawn functions requires careful ordering: you must call `vi.mock()` at the top of the file (hoisted by Vitest's transform), then use `vi.mocked()` inside tests to configure return values. The platform-branch tests additionally need the `vi.resetModules()` + dynamic `import()` dance so the `isWindows` constant re-evaluates with the stubbed platform.

---

<!-- insight:b2a4039b9c02 | session:177aee6d-5c58-4038-9422-d242d4bf0a9c | 2026-04-16T16:23:29.633Z -->
## ★ Insight
The `export { decodeDirName }` re-export pattern keeps `claudeConversations.ts`'s public API unchanged — any code that imports `decodeDirName` from `claudeConversations` (like `ProjectSessions.tsx` line 111) continues to work without modification. The logic has moved to `platform.ts` but the import surface stays the same.

---

<!-- insight:b6400c1b8d87 | session:177aee6d-5c58-4038-9422-d242d4bf0a9c | 2026-04-16T16:21:15.292Z -->
## ★ Insight
`platform.ts` is designed as the single source of truth for all platform differences. This pattern — sometimes called a **platform abstraction layer** — keeps the rest of the codebase free of `if (isWindows)` scattered everywhere, and makes the platform logic testable in isolation by mocking `process.platform`.

---

<!-- insight:d6f40aae7815 | session:177aee6d-5c58-4038-9422-d242d4bf0a9c | 2026-04-16T16:18:54.815Z -->
## ★ Insight
**Why a single `platform.ts` module?** Scattering `process.platform === "win32"` checks across 7+ files creates a maintenance hazard — when a new platform quirk surfaces, you'd need to hunt through every file. A centralized module also makes it possible to mock the entire platform layer in tests, verifying both Windows and Unix code paths from a single OS.

---

<!-- insight:39fad1b95b4b | session:177aee6d-5c58-4038-9422-d242d4bf0a9c | 2026-04-16T16:12:03.623Z -->
## ★ Insight
Cross-platform compatibility typically involves three categories: (1) process management (signals, kill commands), (2) filesystem paths (separators, root conventions), and (3) platform-specific APIs. Let's find all of them.

---

<!-- insight:04b854901012 | session:f2b7faa5-61fb-4851-9c52-43ffaaa01b82 | 2026-04-16T15:39:33.056Z -->
## ★ Insight
Tasks 4 and 5 (HTML + CSS) are written in isolation. The HTML references `style.css` and `screenshots/*.png` using relative paths — this works because on `gh-pages` all three live at the root. The `direction: rtl` trick in CSS (used for the flipped feature rows) is a clean way to reverse a two-column grid without reordering DOM elements, which keeps the markup semantically consistent.

---

<!-- insight:1db7b59728f9 | session:f2b7faa5-61fb-4851-9c52-43ffaaa01b82 | 2026-04-16T15:32:14.376Z -->
## ★ Insight
Each subagent gets zero context from this conversation — I construct exactly what they need in the prompt. This isolation prevents context pollution: the subagent can't accidentally act on earlier decisions or half-formed ideas from our brainstorming session.

---

<!-- insight:eb492709ba77 | session:9fc79516-c5c7-4973-8092-511da852fe17 | 2026-04-16T14:28:13.106Z -->
## ★ Insight
The "Inspired By" section does double duty in an open-source README: it credits sources honestly AND signals to readers that this project sits within a community of related tools — which makes it feel more legitimate and discoverable. The CHANGELOG was the right place to mine these attributions; they were already noted there in context.

---

<!-- insight:b24ef216234d | session:9fc79516-c5c7-4973-8092-511da852fe17 | 2026-04-16T14:27:18.684Z -->
## ★ Insight
A good open-source README for a dev tool follows the same information hierarchy as the product itself: lead with the value proposition (what pain does it solve?), then prove it visually, then earn trust with a quick-start. Features lists work best when grouped by theme rather than listed in implementation order — readers scan for the capability that matters to them, not the order you built things.

---
