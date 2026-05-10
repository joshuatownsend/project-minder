# Library

The Library is a curated collection of production-ready Claude Code configuration files — commands, skills, and agents — that ship with Project Minder and can be applied to any of your projects with one click.

## What's in the library

| Kind | Examples |
|------|----------|
| **Commands** | `/review`, `/commit`, `/debug`, `/test-gen`, `/document` |
| **Skills** | `code-reviewer`, `test-writer`, `doc-writer`, `security-auditor`, `git-workflow`, `pr-reviewer`, `refactorer` |
| **Agents** | `backend-architect`, `security-reviewer`, `test-engineer`, `code-explainer` |

## Applying a library item

1. Open **Catalog → Library**
2. Find the item you want (search by name, description, or tag; filter by kind)
3. Click a row to expand it
4. Choose the target project from the dropdown
5. Click **Preview** to see what would change (dry-run), or **Apply** to write the file

Applied items use the `skip` conflict policy — if the file already exists in your project, it won't be overwritten.

## Via the New Project wizard

When you create a new project through **+ New** → **New Project**, you can select library items on the "Items" step. The chosen items are applied automatically after the project directory is created.

## File locations

Library items are written to the standard Claude Code config locations within your project:

| Kind | Destination |
|------|-------------|
| Command | `.claude/commands/<name>.md` |
| Skill | `.claude/skills/<name>.md` |
| Agent | `.claude/agents/<name>.md` |
