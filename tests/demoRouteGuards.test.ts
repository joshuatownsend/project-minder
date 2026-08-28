import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as nodeFs } from "fs";
import { NextRequest } from "next/server";

import { GET as plansDetailGET } from "@/app/api/plans/[slug]/route";
import { GET as adapterConfigGET } from "@/app/api/adapters/[id]/config/route";
import { GET as claudeHomesGET } from "@/app/api/claude-homes/route";
import { demoPlans } from "@/lib/demo/plans";
import { preserveEnvVars } from "./_helpers/preserveEnv";

// #421 — a bare `delete process.env.X` in teardown restores this file's own
// assignment and destroys anything it INHERITED, and vitest reuses a worker
// across files, so the erasure outlives this one. Capture and put back instead.
preserveEnvVars(["MINDER_DEMO"]);

/**
 * The two W12 guards that do NOT sit at a shared loader.
 *
 * `/api/plans/[slug]` opens the plan file itself rather than going through
 * `scanClaudePlans()`, and `/api/adapters/[id]/config` calls the adapter's own
 * `readConfig()`. Both therefore carry the guard in the handler, which is the
 * placement with nothing upstream to catch a regression — so they are tested
 * through the handler rather than through the fixture function.
 *
 * `/api/claude-homes` (#479) joins them for the same reason, and is the one
 * whose leak is purely about PATHS: both arrays carry absolute host paths — the
 * machine username, where the user keeps their Claude homes, and their WSL
 * distro names — and the banner renders an unavailable one verbatim.
 * (Codex P1, PR #510.)
 */
describe("route-level demo guards (no loader seam behind them)", () => {
  beforeEach(() => {
    process.env.MINDER_DEMO = "1";
  });
  afterEach(() => {
    delete process.env.MINDER_DEMO;
    vi.restoreAllMocks();
  });

  const params = <T,>(v: T) => ({ params: Promise.resolve(v) });

  it("plan detail serves a fixture body and never opens a file", async () => {
    const readFile = vi.spyOn(nodeFs, "readFile");
    const slug = demoPlans(Date.now())[0].slug;

    const res = await plansDetailGET(
      new NextRequest(`http://localhost:4100/api/plans/${slug}`),
      params({ slug })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.body).toContain("#");
    expect(body.path).toContain("\\Users\\demo\\");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("claude-homes reports empty coverage and never probes the real homes", async () => {
    // There is no synthetic substitute to serve here, so it reports full
    // coverage of nothing — which is the honest demo answer: a demo machine
    // has no unreadable homes to warn about, and the banner stays hidden.
    const opendir = vi.spyOn(nodeFs, "opendir");
    const res = await claudeHomesGET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ readable: [], unavailable: [], complete: true });
    // Part of the contract, and the help page promises it on EVERY response
    // — a header-only client would otherwise get an indeterminate answer in
    // exactly the deployment where it cannot read paths from the body.
    expect(res.headers.get("X-Minder-Homes-Unavailable")).toBe("0");
    // The guard sits BEFORE `readConfig`, so nothing is opened on a viewer's
    // behalf — not a filesystem probe, and not a `wsl.exe` round-trip.
    expect(opendir).not.toHaveBeenCalled();
  });

  it("plan detail 404s for a real plan slug instead of reading it", async () => {
    // The discriminating probe: a slug that exists in the user's real
    // ~/.claude/plans but is not a fixture. Serving 200 here is the leak.
    const readFile = vi.spyOn(nodeFs, "readFile");
    const res = await plansDetailGET(
      new NextRequest("http://localhost:4100/api/plans/i-recently-read-this-temporal-crane"),
      params({ slug: "i-recently-read-this-temporal-crane" })
    );

    expect(res.status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("plan detail still rejects a traversal-shaped slug in demo mode", async () => {
    // The guard sits after slug validation, so the 400 must survive it.
    const res = await plansDetailGET(
      new NextRequest("http://localhost:4100/api/plans/x"),
      params({ slug: "../../secrets" })
    );
    expect(res.status).toBe(400);
  });

  it("adapter config serves a synthetic home, not the real harness config", async () => {
    const res = await adapterConfigGET(
      new NextRequest("http://localhost:4100/api/adapters/codex/config"),
      params({ id: "codex" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.home).toContain("\\Users\\demo\\");
    expect(body.present).toBe(true);
    // Rules carry file *contents* on the real path — the most sensitive part.
    for (const r of body.rules ?? []) expect(r.content).not.toContain("joshu");
  });

  it("adapter config still 404s for an unknown harness id", async () => {
    // The guard is placed after the unknown-id check, so junk ids behave
    // identically in both modes rather than being handed a fixture.
    const res = await adapterConfigGET(
      new NextRequest("http://localhost:4100/api/adapters/not-a-harness/config"),
      params({ id: "not-a-harness" })
    );
    expect(res.status).toBe(404);
  });
});
