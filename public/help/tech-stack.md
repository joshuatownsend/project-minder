# Tech Stack Detection

Project Minder automatically detects the technologies used in each project and displays them as badges on project cards and detail pages.

## What Gets Detected

| Category | Examples |
|----------|----------|
| **Framework** | Next.js, Vite, Express, Remix, Astro, Hono, SvelteKit |
| **ORM** | Prisma, Sequelize |
| **Styling** | Tailwind CSS, Styled Components |
| **Database** | PostgreSQL, MySQL, MongoDB, SQLite |
| **Monorepo** | Monorepo / Workspaces |
| **Docker** | Shown when a `docker-compose.yml` is present |

## How Detection Works

Tech stack information is pulled from each project's `package.json`, environment files, and configuration files during the scan. No manual tagging is needed.

## Rescanning

If you've added new dependencies or changed your project setup, click the **refresh button** on the dashboard to rescan and update the detected stack.
