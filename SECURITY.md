# Security Policy

## Scope

Project Minder is a **local-only developer tool** — it runs on your machine and reads your local project files. It does not have user accounts, remote databases, or publicly exposed endpoints. The traditional web-application vulnerability classes (CSRF, session hijacking, authentication bypass) do not apply.

**In scope** for security reports:
- Path traversal in the apply layer (`src/lib/template/apply*.ts`) that could read or write files outside the intended target directory
- The MCP security scanner (`src/lib/scanner/mcpSecurityScanner.ts`) missing a known-dangerous pattern class
- The OTEL ingest routes (`/api/otel/v1/logs`, `/api/otel/v1/metrics`) accepting requests from non-localhost origins
- Anything that causes one project's data to appear in another project's dashboard view

**Out of scope:**
- Denial-of-service via a malicious local file (single-user tool; you control your own files)
- Vulnerabilities in unpatched upstream dependencies

## Reporting

**Preferred:** Open a [GitHub Security Advisory](https://github.com/joshuatownsend/project-minder/security/advisories/new) — this keeps the report private until a fix is available.

**Alternative:** Email `joshuatownsend@gmail.com` with `[SECURITY]` in the subject. Expect a reply within 3 business days.

Please allow up to 14 days for a fix before public disclosure. Critical issues (arbitrary code execution) will be prioritized for a 7-day turnaround.
