# Security

Project Minder is a local-only tool — it runs on your machine and reads your local files. It has no user accounts or publicly exposed endpoints. `src/proxy.ts` (Next.js 16's proxy convention, formerly `middleware.ts`) enforces a Host allowlist on every `/api/*` request (defeating DNS-rebinding attacks from a hostile web page) and an Origin allowlist on state-changing requests (defeating cross-site request forgery); `/api/mcp` has its own equivalent protection built into the MCP transport.

## Reporting an issue

**Preferred:** Open a [GitHub Security Advisory](https://github.com/joshuatownsend/project-minder/security/advisories/new). This keeps the report private until a fix is ready.

**Alternative:** Email `joshuatownsend@gmail.com` with `[SECURITY]` in the subject.

Expect a response within 3 business days. Please allow up to 14 days for a fix before public disclosure.

## What to report

- Path traversal in the apply layer (`src/lib/template/apply*.ts`)
- The MCP security scanner missing a known-dangerous pattern
- OTEL ingest routes accepting requests from non-localhost origins
- Data from one project appearing in another project's view

## What not to report

- Denial-of-service via a malicious local file (single-user tool; you control your own files)
- Vulnerabilities in unpatched upstream dependencies

See [SECURITY.md](https://github.com/joshuatownsend/project-minder/blob/main/SECURITY.md) for the full policy.
