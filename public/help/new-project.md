# New Project

The New Project wizard creates a new project directory under your devRoot and optionally populates it with curated library items in one guided flow.

## Steps

1. **Details** — Enter a display name and folder name. The folder name is auto-derived from the display name but can be overridden. The folder is created at `devRoot/<folder-name>`.

2. **Stack** — Choose your primary language (TypeScript, Python, Go, or Rust). This pre-selects relevant library items on the next step.

3. **Items** — Review and adjust the pre-selected library items. Any item in the Library can be added or removed. These will be applied to your new project after creation.

4. **Confirm** — Review your choices and click **Create project**. The wizard:
   - Creates the directory
   - Runs `git init`
   - Applies all selected library items (using `skip` conflict policy)
   - Redirects you to the dashboard where the new project appears

## Access

- Dashboard toolbar → **New** button
- AppNav → **+ New**

## Notes

- The wizard only creates the project directory and applies Claude Code config files. It does not scaffold application code, install packages, or set up a framework — use your language's standard tooling for that.
- If the target directory already exists, the wizard will show an error on the Confirm step.
- Library items are applied with `conflict: "skip"` — existing files are never overwritten.
