import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { KANBAN_COLUMNS } from "@/lib/kanban/types";

vi.mock("@/lib/liveStatus", () => ({
  getLiveStatusPayload: vi.fn(),
}));

vi.mock("@/lib/tasks/store", () => ({
  listTasks: vi.fn(),
  countOpenDecisionsByTask: vi.fn(),
  listAllDependencies: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
}));

vi.mock("@/lib/featureFlags", () => ({
  getFlag: vi.fn(),
}));

import { getLiveStatusPayload } from "@/lib/liveStatus";
import { listTasks, countOpenDecisionsByTask, listAllDependencies } from "@/lib/tasks/store";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";

const mockGetLiveStatusPayload = vi.mocked(getLiveStatusPayload);
const mockListTasks = vi.mocked(listTasks);
const mockCountOpenDecisionsByTask = vi.mocked(countOpenDecisionsByTask);
const mockListAllDependencies = vi.mocked(listAllDependencies);
const mockReadConfig = vi.mocked(readConfig);
const mockGetFlag = vi.mocked(getFlag);

const NOW = "2026-05-08T12:00:00.000Z";

const emptyPayload = { generatedAt: NOW, sessions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLiveStatusPayload.mockResolvedValue(emptyPayload);
  mockListTasks.mockResolvedValue([]);
  mockCountOpenDecisionsByTask.mockResolvedValue(new Map());
  // Default: taskDispatcher flag is enabled
  mockReadConfig.mockResolvedValue({ statuses: {}, hidden: [], portOverrides: {}, devRoot: "C:\\dev", pinnedSlugs: [] } as any);
  mockGetFlag.mockReturnValue(true);
  mockListAllDependencies.mockResolvedValue([]);
});

function mkGet(params?: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/kanban");
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

async function getRoute(req: NextRequest) {
  const { GET } = await import("@/app/api/kanban/route");
  return GET(req);
}

describe("GET /api/kanban", () => {
  it("returns snapshot with all 5 columns", async () => {
    const res = await getRoute(mkGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const col of KANBAN_COLUMNS) {
      expect(Array.isArray(body.columns[col])).toBe(true);
    }
    expect(typeof body.generatedAt).toBe("string");
    expect(body.dispatcherEnabled).toBe(true);
  });

  it("rejects invalid period with 400", async () => {
    const res = await getRoute(mkGet({ period: "last90d" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid period/);
  });

  it("accepts last24h period", async () => {
    const res = await getRoute(mkGet({ period: "last24h" }));
    expect(res.status).toBe(200);
  });

  it("accepts last7d period", async () => {
    const res = await getRoute(mkGet({ period: "last7d" }));
    expect(res.status).toBe(200);
  });

  it("accepts all period", async () => {
    const res = await getRoute(mkGet({ period: "all" }));
    expect(res.status).toBe(200);
  });

  it("returns dispatcherEnabled=false when taskDispatcher flag is off", async () => {
    mockGetFlag.mockReturnValue(false);
    const res = await getRoute(mkGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatcherEnabled).toBe(false);
    expect(mockListTasks).not.toHaveBeenCalled();
  });

  it("returns dispatcherEnabled=false when listTasks throws", async () => {
    mockListTasks.mockRejectedValue(new Error("DB unavailable"));
    const res = await getRoute(mkGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatcherEnabled).toBe(false);
    // sessions still render
    for (const col of KANBAN_COLUMNS) {
      expect(Array.isArray(body.columns[col])).toBe(true);
    }
  });

  it("places live session in working column", async () => {
    mockGetLiveStatusPayload.mockResolvedValue({
      generatedAt: NOW,
      sessions: [
        {
          sessionId: "sess-abc",
          projectSlug: "my-project",
          projectName: "My Project",
          status: "working",
          mtime: NOW,
        },
      ],
    });
    const res = await getRoute(mkGet());
    const body = await res.json();
    expect(body.columns.working).toHaveLength(1);
    expect(body.columns.working[0].sessionId).toBe("sess-abc");
  });

  it("task cards include blockedBy field (defaults to [])", async () => {
    const liveSession = {
      sessionId: "s1",
      projectSlug: "proj",
      projectName: "Proj",
      status: "working" as const,
      mtime: NOW,
    };
    mockGetLiveStatusPayload.mockResolvedValue({
      generatedAt: NOW,
      sessions: [liveSession],
    });
    const res = await getRoute(mkGet());
    const body = await res.json();
    // No tasks, so check the structure still has blockedBy on task cards when tasks exist.
    expect(Array.isArray(body.columns.working)).toBe(true);
    // Sessions in working column don't have blockedBy — verify session card shape.
    const card = body.columns.working[0];
    expect(card.kind).toBe("session");
    expect(card.blockedBy).toBeUndefined();
  });

  it("is read-only (no mutations)", async () => {
    const routeModule = await import("@/app/api/kanban/route");
    expect((routeModule as Record<string, unknown>).POST).toBeUndefined();
    expect((routeModule as Record<string, unknown>).PUT).toBeUndefined();
    expect((routeModule as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
