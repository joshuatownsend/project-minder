# SQL Workbench

The SQL page gives you a read-only query interface against the local SQLite session index (`~/.minder/index.db`).

## Running queries

Type a `SELECT` statement in the editor and press **⌘/Ctrl+Enter** (or click **Run**) to execute it. Results appear below as a virtualized table.

Only `SELECT` and `WITH … SELECT` (CTEs) are accepted. Writes, DDL, `PRAGMA` mutations, `ATTACH`, and `VACUUM` are all rejected by two independent layers:
1. A regex pre-filter on the first keyword
2. `stmt.readonly` bytecode introspection — catches `WITH … INSERT RETURNING` CTEs that pass a regex

## Schema sidebar

The left sidebar lists every table with its columns. Click a table's chevron to expand the column list. Click **↗ insert SELECT** to paste a `SELECT * FROM "<table>" LIMIT 100;` template into the editor.

## Results

| Feature | Details |
|---|---|
| Virtualized rows | Only visible rows are rendered — safe on large result sets |
| Truncation | Results are capped at 10,000 rows; a banner appears when truncated |
| NULL display | `NULL` values are shown in italics |
| Column widths | Fixed at 300px max per column — scroll horizontally for wide tables |

## Export

Export buttons appear once a query returns rows:
- **CSV** — RFC-4180 compliant (double-quote escaping; CRLF line endings)
- **JSON** — pretty-printed array of row objects

## Query history

Your last 20 queries are stored in `localStorage` under the key `pm:sql-history`. Click the clock icon to browse and re-run previous queries. Adjacent duplicate entries are deduplicated.

## Database availability

The SQL workbench requires the optional `better-sqlite3` dependency to be installed. If the database is unavailable, a 503 error is shown with a link to the Setup page.
