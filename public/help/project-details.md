# Project Detail Page

Click any project card on the dashboard to open its detail page. The detail page has a header section and four tabs.

## Header

At the top you'll find:

- **Back button** — returns to the dashboard
- **Project name** and full file path
- **Tech stack badges** — detected framework, ORM, styling, etc.
- **Status selector** — click **Active**, **Paused**, or **Archived** to change the project's status
- **Quick actions:**
  - **VS Code** — opens the project folder in Visual Studio Code
  - **Terminal** — opens Windows Terminal in the project directory

## Overview Tab

The default tab shows a structured summary of the project.

### Dev Server Control

Start, stop, and restart the project's dev server directly from the dashboard. See [Dev Servers](dev-servers.md) for details.

### Ports

- **Dev server port** — the port used when starting the dev server (editable — see [Ports](ports.md))
- **Database port** — detected from environment files
- **Docker ports** — service names and host-to-container port mappings from `docker-compose.yml`

### Database

If a database is detected, shows the type (PostgreSQL, MySQL, MongoDB, etc.), host, port, and database name.

### External Services

Lists any external APIs or services detected in the project (e.g., AWS, Firebase, Auth0), shown as badges.

### Git Status

- Current branch name
- Time since last commit
- Last commit message
- Number of uncommitted changes (if any)

## Context Tab

Displays the full contents of the project's `CLAUDE.md` file, if one exists. This is the context file that Claude reads when working on the project.

## TODOs Tab

Shows TODO items parsed from the project's `TODO.md` file:

- A **progress bar** showing completion percentage
- Each item listed with a checkmark (done) or open circle (pending)
- A total count of completed vs. remaining items

## Claude Tab

Shows your Claude session history for this project:

- Total number of sessions
- When the most recent session occurred
- A preview of the first prompt from the latest session
