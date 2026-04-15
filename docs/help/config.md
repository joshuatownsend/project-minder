# Configuration

The Config page (`/config`) lets you customize how Project Minder scans and displays your projects.

## Scan Roots

Add one or more directories for Project Minder to scan. For each root, Project Minder checks its immediate child directories for git repositories.

- **Primary root** — the first entry. Used as the base path for dev server security validation and shown in the header.
- **Ordering** — use the up/down arrows to reorder. Move your most-used root to the top.
- **Adding** — type a full path (e.g. `C:\work`) and click Add or press Enter.
- **Removing** — click the trash icon. You must keep at least one root.

> **Slug collisions**: if two roots contain directories with the same name (same slug), the first root wins and the duplicate is skipped.

## Scan Behavior

### Batch size

Controls how many projects are scanned in parallel per root. Default is 10.

- Lower values (3–5) reduce CPU pressure during large scans.
- Higher values (15–30) are faster on machines with many cores.
- Range: 1–50.

## Dashboard Defaults

These settings control the initial state of the project dashboard on each page load. You can still change them per session via the sort/filter controls.

| Setting | Options |
|---------|---------|
| Default sort | Last Activity, Name, Claude Session |
| Default status filter | All, Active, Paused, Archived |

## Hidden Projects

Projects hidden from the dashboard appear here. Directories in this list are skipped during every scan — they won't show up in counts or cards.

To hide a project, use the three-dot menu on its card. To unhide, click **Unhide** next to the project name on this page.

## Saving Changes

Edits to scan roots and scan behavior are not applied until you click **Save Changes**. Hidden project changes (unhide) take effect immediately.

After saving, the next scan will pick up new roots. You can trigger an immediate rescan from the dashboard footer.
