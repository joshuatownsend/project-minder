# Agent Observatory — Wave 4-9 Roadmap

Sketch-level wave proposals synthesized from cross-repo analysis of six reference observability projects (disler/claude-code-hooks-multi-agent-observability, Ngxba/claude-code-cli-ui, graykode/abtop, mukul975/claude-team-dashboard, Glsme/agent-monitor, Ericonaldo/AgentMonitor). Each wave is PR-shaped, ~1 day of work, and explicitly deferred from Wave 3.

Full idea menu with source attribution lives in the session plan doc (local to the dev who ran the planning session).

---

## Wave 4 — Hook event ingestion endpoint + SSE bus

**Why:** Today the hook ring buffer only stores hook events when Project Minder's own server is running AND a hook script writes to it. Waves 1-3 only surface what's already there. Wave 4 opens the ingestion point so any Claude Code session can push events.

**Key files:**
- `src/app/api/hook-events/route.ts` (NEW) — `POST /api/hook-events` receives `{source_app, session_id, event_type, payload, ts}` JSON from a PowerShell/Python hook script. Writes into the existing in-memory hook ring buffer via `pushHookEvent()`.
- `src/app/api/hook-events/stream/route.ts` (NEW) — `GET /api/hook-events/stream` SSE endpoint that fans out events to the `/agent-view` client. Extends the existing `useAgentViewStream` or adds a parallel `useHookEventStream`.
- Hook installer page: a `/setup/hooks` UI that writes `.claude/hooks/send_event.ps1` (Windows) into a user-chosen project or globally via `~/.claude/settings.json`. The script POSTs to `http://localhost:4100/api/hook-events`.
- Add `PostToolUseFailure` and `PermissionRequest` as first-class event types that surface on the Kanban card as ⚠ / 🔐 badges.

**Pattern source:** disler/claude-code-hooks-multi-agent-observability (exact hook event types and WebSocket fan-out adapted for SSE).

**Rough LOC:** ~300 backend + ~150 UI. No new deps (Next.js streaming responses support SSE natively).

**Deferred because:** Wave 3 is pure value extraction with zero new ingestion infrastructure. Wave 4 needs user setup (hook installer) and introduces a server-side POST endpoint that needs CSRF consideration.

---

## Wave 5 — Process/port discovery scanner for externally-started agents

**Why:** Today Project Minder only sees sessions once JSONL appears. An agent started from any terminal with plain `claude` shows up late. Wave 5 borrows abtop's process-enumeration approach to surface externally-started agents immediately.

**Key files:**
- `src/lib/agentProcessScanner.ts` (NEW) — runs `tasklist /FO CSV /NH` on Windows to enumerate `claude.exe` processes, cross-references PID → cwd via `wmic process get ProcessId,CommandLine` or `/proc` on Linux, maps cwd → project slug. Exposes `getExternalAgentProcesses(): {pid, sessionId?, projectSlug?, ports: number[]}[]`.
- `src/lib/agentView/aggregate.ts` — call the scanner to inject sessions that have a running process but no JSONL entry yet. Badge these as `EXT` (external process, liveness inferred from PID alone).
- `src/components/agent-view/AgentCard.tsx` — render `EXT` badge when `livenessSource === "process"`.

**Pattern source:** graykode/abtop (process table walk + open port discovery).

**Rough LOC:** ~200 scanner + ~50 UI.

**Deferred because:** Windows `wmic` / `netstat` calls are slow (~200ms). Need a background poll with a dedicated TTL rather than running on every SSE delta. Also depends on wave 4's event bus for maximum fidelity.

---

## Wave 6 — Live spend ticker + budget alerts + rate-limit forecaster

**Why:** Wave 3 wires historical cost onto the Kanban card. Wave 6 makes cost a real-time signal with configurable budgets and actionable alerts.

**Key files:**
- `.minder.json` config schema extension: `budgets: { sessionUsd?: number; dailyUsd?: number; hourlyUsd?: number }`.
- `src/lib/agentView/budgetMonitor.ts` (NEW) — subscribes to the `globalThis` event bus, accumulates per-session spend from live JSONL tail events, fires a browser `Notification` + toast when a session crosses its budget threshold.
- `src/components/agent-view/AgentCard.tsx` — amber border tint when session is within 80% of budget; red tint at threshold.
- Rate-limit forecaster: plot 5-hour rolling spend vs. estimated tier cap (infer tier from observed costs). Warn at 70% / hard alert at 90% via a banner on `/agent-view`.

**Pattern source:** graykode/abtop (rate-limit headroom) + disler (PostToolUseFailure hooks).

**Rough LOC:** ~250 monitor + ~100 UI.

**Deferred because:** Stable live cost (Wave 3 A) is a prerequisite. Budget thresholds need a config UI and the OS `Notification` API requires HTTPS or `localhost` — straightforward but not zero-config.

---

## Wave 7 — Session replay scrubber + subagent flame chart + retry-cycle highlights

**Why:** The existing session detail view is a static timeline. A scrubber turns it into a rewind-and-play debugger. Flame chart and retry highlights give debugging-grade insight into what went wrong without opening logs.

**Key files:**
- `src/components/sessions/SessionReplayScrubber.tsx` (NEW) — wraps `SessionDetailView` with an `<input type="range" min=0 max={turns.length}>` that indexes into the turn array. Each position reveals accumulated tool calls + content up to that turn. Pure client-side, no new API.
- `src/components/agent-view/SubagentFlameChart.tsx` (NEW) — SVG flame chart where rows are agents (main thread + each sidechain) and columns are time. `SubagentStart → SubagentStop` spans become colored rectangles, colored by agent type. Data from existing `loadOrchestrationGraph`.
- `RetryHighlight` — extend the existing `oneShotDetector` results into the replay timeline as red-bracketed spans when Edit→Bash(test)→re-edit cycles are detected.

**Pattern source:** mukul975/claude-team-dashboard (planned replay, not yet shipped — we ship first).

**Rough LOC:** ~250 scrubber + ~200 flame chart + ~80 retry highlight.

**Deferred because:** No dependency on Wave 4-6. Could be done in parallel — deferred only to keep Wave 3 focused on "activate what's stubbed".

---

## Wave 8 — Agent dependency graph + ⌘K command palette + tab hotkeys

**Why:** `AgentsBrowser` shows a flat list. Multi-agent systems have implicit dependency structures (A spawns B which spawns C) that are invisible in a list. The command palette and hotkeys are pure UX polish that pays dividends across the whole app.

**Key files:**
- `src/app/agents/graph/page.tsx` (NEW) — `/agents/graph` route renders a force-directed SVG graph of agent→agent references. Node data from `buildAgentAliasMap`; edges from scanning agent body markdown for `Task(subagent_type=X)`, `@agent-name`, and frontmatter `requires:` fields. ~200 LOC pure SVG (no D3 unless count requires it).
- `src/components/CommandPalette.tsx` (NEW) — `⌘K` / `Ctrl+K` global listener. Items: open project, jump to session, force scan, navigate to `/agent-view`, `/sessions`, `/agents`, `/usage`. Mounted in `AppNav`. Pattern: `onKeyDown` on `window` in a `useEffect`.
- Tab hotkeys: `⌘1` → dashboard, `⌘2` → sessions, `⌘3` → agents, `⌘4` → skills, `⌘5` → stats, `⌘6` → usage, `⌘7` → manual-steps, `⌘8` → insights. Added to `AppNav` via the same `useEffect`.

**Pattern source:** mukul975 (command palette + hotkeys), Ngxba (dependency graph concept).

**Rough LOC:** ~200 graph + ~150 palette + ~50 hotkeys.

**Deferred because:** Dependency graph requires the catalog indexer's cross-reference parser (body scan for agent mentions), which is a distinct feature from catalog lookup.

---

## Wave 9 (optional / fun) — Pixel-office alternative view

**Why:** High-information-density at-a-glance, low cognitive load. Same state machine as the Kanban; different render. Excellent "wow factor" for demos.

**Key files:**
- `src/components/agent-view/PixelOfficeView.tsx` (NEW) — CSS-grid "office floor" with rooms. State → room mapping: `working` → desk, `waiting` → reception, `idle` → lounge, `failed` → infirmary, `completed`/`stopped` → exit. Each agent is a 16×16 sprite div with a project-color dot + initials. CSS `transform: translate(…)` walk animation fires on status change.
- Toggle button on `/agent-view` toolbar switches between Kanban and Office views. Preference persisted to `localStorage`.

**Pattern source:** Glsme/agent-monitor (sprite-per-agent metaphor, room-based state visualization).

**Rough LOC:** ~300 (pure CSS + Tailwind transforms, no external animation library).

**Deferred because:** No functional gap — pure "wow". Schedule after Wave 7 when the observable behavioral model is fully debugged.

---

## Explicitly deferred (no wave assigned)

- **PTY-in-browser** (Ericonaldo: node-pty + xterm.js) — brings external service complexity and a shell escape surface. Security review required before considering.
- **Feishu/Lark / Telegram / Discord bidirectional bridges** — useful but introduces external-service dependencies contrary to Project Minder's local-only stance.
- **Agent answer-back from dashboard** (clicking approval prompts in UI) — requires the hook script to write back to a named pipe the CLI is polling. Footgun risk.
- **PTY relay for remote access** — out of scope for a local-only dashboard.
