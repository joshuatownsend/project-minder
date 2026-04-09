# Quick Actions

The project detail page includes buttons to quickly open your project in external tools.

## VS Code

Click **VS Code** to open the project folder directly in Visual Studio Code. This uses the `vscode://` URL scheme, so VS Code must be installed on your system.

## Terminal

Click **Terminal** to open Windows Terminal with the working directory set to the project folder.

## Opening the Dev Server

When a dev server is running, click the **localhost:PORT** button to open it in your default browser. See [Dev Servers](dev-servers.md) for more.

## Quick Add TODOs

The **Quick Add** button in the dashboard header (keyboard shortcut: **Shift+T**) opens a modal for dumping ideas into one or many projects at once.

- **Pick projects** — check one or more projects from the searchable list. Archived projects are hidden by default. Use **All visible** or **Clear** to bulk-toggle the current filtered list.
- **Enter ideas** — type one TODO per line in the textarea. Each non-empty line is appended to the selected projects as `- [ ] your idea`.
- **Submit** — the button shows the total write count (projects × ideas). Each project is updated in parallel; a per-project success/failure list appears below the textarea.

If a project has no `TODO.md` yet, one is created with a `# TODO` header. Existing file contents are always preserved — items are appended to the end, never inserted in the middle.

You can also add TODOs one-project-at-a-time from the **TODOs** tab on the project detail page.
