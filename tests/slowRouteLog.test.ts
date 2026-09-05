import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/serviceLog", () => ({ serviceLog: vi.fn() }));

import { serviceLog } from "@/lib/serviceLog";
import { isSlowRoute, logSlowRoute, SLOW_ROUTE_MS } from "@/lib/slowRouteLog";

describe("slowRouteLog (#559)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(serviceLog).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("isSlowRoute is a threshold comparison, inclusive", () => {
    expect(isSlowRoute(SLOW_ROUTE_MS - 1)).toBe(false);
    expect(isSlowRoute(SLOW_ROUTE_MS)).toBe(true);
    expect(isSlowRoute(100, 50)).toBe(true);
  });

  it("writes nothing for a fast response", () => {
    const started = Date.now();
    vi.advanceTimersByTime(200);
    logSlowRoute("/api/usage", started, { period: "week" });
    expect(serviceLog).not.toHaveBeenCalled();
  });

  it("writes one warn line with the route, elapsed time and detail for a slow one", () => {
    const started = Date.now();
    vi.advanceTimersByTime(54_000);
    logSlowRoute("/api/usage", started, { period: "week", backend: "db" });
    expect(serviceLog).toHaveBeenCalledTimes(1);
    expect(serviceLog).toHaveBeenCalledWith({
      level: "warn",
      subsystem: "route",
      msg: "slow response: /api/usage took 54000 ms",
      route: "/api/usage",
      elapsedMs: 54_000,
      period: "week",
      backend: "db",
    });
  });
});
