/**
 * `GET /api/telemetry/hook-activity` — the source parameter.
 *
 * The card's Auto / OTEL / Transcript toggle is only worth anything if the
 * route forwards the choice. Before this existed the route hard-coded `auto`,
 * which makes the transcript pipeline unreachable from the UI on any machine
 * where OTEL has data: `since` is a lower bound, so no period ever falls back.
 *
 * The validation half matters for the same reason. A bad value must not be
 * coerced to `auto` — the two pipelines count different things (OTEL keys on
 * the hook name, the transcript on the command it ran), so silently answering
 * with the other one hands back a number that is not an approximation of what
 * was asked for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getHookActivity = vi.fn();

vi.mock("@/lib/db/otelQueries", () => ({
  getHookActivity: (...args: unknown[]) => getHookActivity(...args),
}));

async function get(url: string) {
  const { GET } = await import("@/app/api/telemetry/hook-activity/route");
  return GET(new NextRequest(url));
}

const EMPTY = { hooks: [], totalFires: 0, hasData: false };

describe("GET /api/telemetry/hook-activity", () => {
  beforeEach(() => {
    getHookActivity.mockReset();
    getHookActivity.mockResolvedValue(EMPTY);
  });

  it.each(["otel", "transcript", "auto"])("forwards source=%s to the query layer", async (source) => {
    const res = await get(`http://localhost:4100/api/telemetry/hook-activity?source=${source}`);
    expect(res.status).toBe(200);
    expect(getHookActivity).toHaveBeenCalledWith(expect.objectContaining({ source }));
  });

  it("passes source undefined when the caller names none, preserving the auto default", async () => {
    // Explicitly `undefined` rather than the string "auto": the default lives
    // in `getHookActivity`, and duplicating it here would be a second place
    // for it to drift.
    await get("http://localhost:4100/api/telemetry/hook-activity");
    expect(getHookActivity).toHaveBeenCalledWith(expect.objectContaining({ source: undefined }));
  });

  it("rejects an unrecognized source instead of falling back to auto", async () => {
    const res = await get("http://localhost:4100/api/telemetry/hook-activity?source=otelx");
    expect(res.status).toBe(400);
    // The load-bearing half: a rejected request must not have been answered.
    expect(getHookActivity).not.toHaveBeenCalled();
    expect((await res.json()).error).toMatch(/source/i);
  });

  it("rejects an unparseable since without consulting the query layer", async () => {
    const res = await get("http://localhost:4100/api/telemetry/hook-activity?since=not-a-date");
    expect(res.status).toBe(400);
    expect(getHookActivity).not.toHaveBeenCalled();
  });

  it("forwards a valid since as epoch milliseconds", async () => {
    await get("http://localhost:4100/api/telemetry/hook-activity?since=2026-08-01T00:00:00.000Z");
    expect(getHookActivity).toHaveBeenCalledWith(
      expect.objectContaining({ since: Date.parse("2026-08-01T00:00:00.000Z") })
    );
  });
});
