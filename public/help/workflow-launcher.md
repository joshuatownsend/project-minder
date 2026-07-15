# Workflow Launcher

The **workflow launcher** turns a curated workflow into a single click. Each chip
dispatches one Claude Code task — scoped to a project — through the same task
dispatcher that powers Swarms, but without the multi-step composer. It's the
gentle on-ramp: pick a project, click a chip, and a run starts.

## Where the chips appear

- **Per-project strip** — a "Quick Launch" row on each project's detail page.
  Chips here dispatch immediately against that project (no picker needed).
- **Global row** — a thin strip under the top bar on every other page. Because
  a task has to run *somewhere*, clicking a global chip first opens a project
  picker; choose a project and the run starts. (The strip is hidden on the
  project detail page, which already has its own.)

Both placements are governed by the **Workflow launcher chips** feature flag
(Settings → Features), which is on by default. Turn it off to hide the launcher
entirely.

## What's on the chips

Two sources sit side by side, separated by a divider:

1. **Curated workflows** — a small hand-written gallery that reads as useful on
   almost any project:
   - 🔍 **Review diff** — read-only review of your uncommitted changes.
   - 🧪 **Test & fix** — run the test suite and fix any failures.
   - 🩺 **Typecheck & lint** — run both and fix what they surface.
   - 📝 **Update CHANGELOG** — add entries for recent commits under `[Unreleased]`.
   - 🧹 **Tidy TODO.md** — archive completed items per the living-checklist convention.
   - 📦 **Dependency audit** — report outdated/vulnerable deps (no changes).
2. **Your skills** — your user-invocable skills (e.g. `/code-review`,
   `/improve`), pulled from the skills catalog. A skill chip dispatches the bare
   `/name` invocation against the chosen project.

Each curated prompt is written to state its own blast radius ("do not modify
files", "only edit CHANGELOG.md") so a one-click launch stays predictable.

## What happens on click

1. A task is created via `POST /api/tasks` with the workflow prompt as its
   description and the project directory in `metadata.projectPath`.
2. The background dispatcher claims it within ~2–30 seconds and runs
   `claude -p` inside that project directory.
3. A toast confirms the launch with a **View in Tasks** link — follow it to
   watch progress, see output, or cancel.

Launched tasks are ordinary dispatcher tasks: they appear on the **Tasks** page,
honor the emergency-stop gate, and run at most a few at a time.

## Notes

- **Demo mode is read-only.** While demo mode is on, launching is disabled and a
  click shows a "Read-only in demo mode" toast — no task is created.
- **Nothing runs silently.** A chip only dispatches when you click it; the toast
  and the Tasks page always reflect what was started.
- **Need more control?** For multi-task or coordinated runs, use the full
  **Swarm** composer instead — the launcher is intentionally the lightweight path.
