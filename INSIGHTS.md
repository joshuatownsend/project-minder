# Insights

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
