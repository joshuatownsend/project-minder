import "server-only";
import { NextResponse } from "next/server";
import { CatalogHomeError } from "@/lib/indexer/homes";

/**
 * HTTP shape of a `home` key the catalog cannot walk (#553). Shared by the
 * agents and skills routes so the two answer identically:
 *
 *  - 404 `unknown`      — no configured Claude home has that key
 *  - 503 `unavailable`  — the home is configured but unreadable this cycle
 *                         (a stopped WSL distro; never started to find out)
 *
 * Anything that is not a `CatalogHomeError` is rethrown — it is a bug, not a
 * request problem, and must not be dressed as one.
 */
export function catalogHomeErrorResponse(err: unknown): NextResponse {
  if (err instanceof CatalogHomeError) {
    return NextResponse.json(
      {
        error: err.message,
        problem: err.problem,
        home: err.key,
        ...(err.reason ? { reason: err.reason } : {}),
        ...(err.distro ? { distro: err.distro } : {}),
      },
      { status: err.status }
    );
  }
  throw err;
}

/**
 * `X-Minder-Unresolved-Plugins`: the plugins in the walked home whose registry
 * `installPath` no path mapping could rewrite, so nothing under them was
 * listed. A header rather than a body field because these routes return the
 * bare row array and every client parses it as such; names are URL-encoded
 * so the header stays ASCII whatever a marketplace calls a plugin.
 */
export function setUnresolvedPluginsHeader(response: NextResponse, names: readonly string[]): void {
  if (names.length === 0) return;
  response.headers.set("X-Minder-Unresolved-Plugins", names.map((n) => encodeURIComponent(n)).join(","));
}
