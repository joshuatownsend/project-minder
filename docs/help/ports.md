# Ports

Project Minder detects and displays port numbers for each project's dev server, database, and Docker services.

## Editing the Dev Server Port

You can override the detected dev server port for any project:

1. **On a project card** — click the port number (next to the network icon). An edit field appears.
2. **On the detail page** — click the port number in the Ports section of the Overview tab.

To save your change, press **Enter** or click the checkmark. To cancel, press **Escape** or click the X.

Valid port numbers are **1–65535**. Clearing the field removes your override and reverts to the auto-detected port.

Port overrides are saved in your configuration and persist between sessions.

## Port Conflict Warnings

If two or more projects use the same port, a **warning banner** appears at the top of the dashboard. The banner lists which ports conflict and which projects are affected, grouped by type (dev server, database, or Docker).

Resolve conflicts by editing one project's port to a different number.

## Other Ports

- **Database port** — detected automatically from environment files. Shown on the detail page but not editable in the dashboard.
- **Docker service ports** — detected from `docker-compose.yml`. Shows each service name with its host-to-container port mapping.
