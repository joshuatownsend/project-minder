# Dev Servers

Project Minder can start, stop, and restart your project's dev server without leaving the dashboard.

## Starting a Dev Server

There are two ways to start a dev server:

- **From the dashboard** — click the **Start** button on any project card
- **From the detail page** — open a project and click **Start** in the Overview tab

The server launches in the background using the project's detected start command and port.

## Stopping a Dev Server

- **From the dashboard** — click **Stop** next to the running status badge on the project card
- **From the detail page** — click the red **Stop** button

## Restarting

On the detail page, click **Restart** to stop and immediately re-launch the server. This is useful after changing configuration or pulling new code.

## Opening in Browser

When a server is running, click the **localhost:PORT** button on the detail page to open the dev server in your browser.

## Server Output

On the detail page, toggle the **output viewer** to see the last 200 lines of server output (stdout and stderr). The viewer auto-scrolls as new output arrives — helpful for spotting startup errors or watching logs.

## Status Indicators

| Status | Meaning |
|--------|---------|
| **Starting** (blue) | Server is launching |
| **Running** (green) | Server is up and accepting requests |
| **Stopped** (gray) | Server is not running |
| **Errored** (red) | Server exited unexpectedly |

## Good to Know

- Dev server state does not persist across Project Minder restarts. If you restart the dashboard app, any running servers will need to be started again.
- The output viewer stores the most recent 200 lines. Older output is not available.
- Server status polls every 2 seconds while a server is active.
