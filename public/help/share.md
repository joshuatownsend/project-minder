# Share Stats Image

The Share feature generates a shareable SVG image of your Claude Code usage stats. Click the **Share** button in the `/usage` page header to open a preview modal.

## What it shows

The image includes:

- **KPI row** — total sessions, cost, tokens, and current streak
- **Hourly activity strip** — 24-hour distribution of Claude Code usage, colour-coded by intensity
- **Top 5 projects** — horizontal bar chart of projects ranked by cost
- **Model breakdown** — stacked bar showing cost split by Claude model

## Controls

| Control | Effect |
|---|---|
| Period selector | Choose Today / This Week / This Month / All Time |
| Theme toggle | Dark (default) or Light |
| Copy URL | Copies the `/api/share?...` URL for embedding |
| Download SVG | Saves the SVG file locally |

## Direct URL

The image is also available directly at `/api/share` with query parameters:

| Parameter | Default | Values |
|---|---|---|
| `period` | `month` | `today`, `week`, `month`, `all` |
| `theme` | `dark` | `dark`, `light` |
| `project` | — | project slug (filter to one project) |
| `width` | `1200` | 400–2400 |

Example: `/api/share?period=week&theme=light`

## Notes

- The image uses system sans-serif font (no Geist embedding).
- SVG renders cleanly at any resolution — suitable for social sharing or embedding in docs.
- The light theme palette is an invented neutral inversion (the app itself is dark-only).
