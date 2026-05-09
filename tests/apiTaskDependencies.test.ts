import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/tasks/store", () => ({
  getTask: vi.fn(),
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
  listDependencies: vi.fn(),
  CycleError: class CycleError extends Error {
    constructor(taskId: number, blockerId: number) {
      super(`Adding dependency ${taskId}→${blockerId} would create a cycle`);
      this.name = "CycleError";
    }
  },
}));

import { getTask, addDependency, removeDependency, listDependencies, CycleError } from "@/lib/tasks/store";

const mockGetTask = vi.mocked(getTask);
const mockAddDependency = vi.mocked(addDependency);
const mockRemoveDependency = vi.mocked(removeDependency);
const mockListDependencies = vi.mocked(listDependencies);

const TASK_1 = { id: 1, title: "Task 1", status: "pending" } as never;
const TASK_2 = { id: 2, title: "Task 2", status: "pending" } as never;

function mkRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/1/dependencies", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTask.mockResolvedValue(TASK_1);
  mockListDependencies.mockResolvedValue({ blockedBy: [], blocks: [] });
});

describe("GET /api/tasks/[id]/dependencies", () => {
  it("returns 200 with blockedBy and blocks arrays", async () => {
    mockListDependencies.mockResolvedValue({ blockedBy: [3], blocks: [4, 5] });
    const req = mkRequest("GET");
    const { GET } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await GET(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blockedBy).toEqual([3]);
    expect(body.blocks).toEqual([4, 5]);
  });

  it("returns 404 when task not found", async () => {
    mockGetTask.mockResolvedValue(null);
    const req = mkRequest("GET");
    const { GET } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await GET(req, { params: Promise.resolve({ id: "999" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tasks/[id]/dependencies", () => {
  it("returns 201 with the new dependency row", async () => {
    mockGetTask.mockImplementation(async (id) => (id === 1 ? TASK_1 : TASK_2));
    mockAddDependency.mockResolvedValue({ id: 10, task_id: 1, blocker_id: 2, created_at: "" } as never);
    const req = mkRequest("POST", { blockerId: 2 });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task_id).toBe(1);
  });

  it("returns 400 when blockerId equals taskId", async () => {
    const req = mkRequest("POST", { blockerId: 1 });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when blockerId is missing", async () => {
    const req = mkRequest("POST", { blockerId: "not-a-number" });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 409 on cycle", async () => {
    mockGetTask.mockImplementation(async (id) => (id === 1 ? TASK_1 : TASK_2));
    mockAddDependency.mockRejectedValue(new CycleError(1, 2));
    const req = mkRequest("POST", { blockerId: 2 });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/cycle/i);
  });

  it("returns 404 when blocker task not found", async () => {
    mockGetTask.mockImplementation(async (id) => (id === 1 ? TASK_1 : null));
    const req = mkRequest("POST", { blockerId: 2 });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/tasks/[id]/dependencies — malformed id", () => {
  it("returns 400 for non-numeric task id like '12abc'", async () => {
    const req = mkRequest("GET");
    const { GET } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await GET(req, { params: Promise.resolve({ id: "12abc" }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/tasks/[id]/dependencies — input validation", () => {
  it("returns 400 for non-numeric task id like '12abc'", async () => {
    const req = mkRequest("POST", { blockerId: 2 });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "12abc" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when blockerId is a float", async () => {
    const req = mkRequest("POST", { blockerId: 2.5 });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when blockerId is negative", async () => {
    const req = mkRequest("POST", { blockerId: -1 });
    const { POST } = await import("@/app/api/tasks/[id]/dependencies/route");
    const res = await POST(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/tasks/[id]/dependencies/[blockerId] — malformed ids", () => {
  it("returns 400 for non-numeric task id", async () => {
    const req = new NextRequest("http://localhost/api/tasks/abc/dependencies/2", { method: "DELETE" });
    const { DELETE } = await import("@/app/api/tasks/[id]/dependencies/[blockerId]/route");
    const res = await DELETE(req, { params: Promise.resolve({ id: "abc", blockerId: "2" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric blockerId", async () => {
    const req = new NextRequest("http://localhost/api/tasks/1/dependencies/abc", { method: "DELETE" });
    const { DELETE } = await import("@/app/api/tasks/[id]/dependencies/[blockerId]/route");
    const res = await DELETE(req, { params: Promise.resolve({ id: "1", blockerId: "abc" }) });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/tasks/[id]/dependencies/[blockerId]", () => {
  it("returns 204 when edge existed", async () => {
    mockRemoveDependency.mockResolvedValue(true);
    const req = new NextRequest("http://localhost/api/tasks/1/dependencies/2", { method: "DELETE" });
    const { DELETE } = await import("@/app/api/tasks/[id]/dependencies/[blockerId]/route");
    const res = await DELETE(req, { params: Promise.resolve({ id: "1", blockerId: "2" }) });
    expect(res.status).toBe(204);
  });

  it("returns 204 even when edge did not exist (idempotent)", async () => {
    mockRemoveDependency.mockResolvedValue(false);
    const req = new NextRequest("http://localhost/api/tasks/1/dependencies/2", { method: "DELETE" });
    const { DELETE } = await import("@/app/api/tasks/[id]/dependencies/[blockerId]/route");
    const res = await DELETE(req, { params: Promise.resolve({ id: "1", blockerId: "2" }) });
    expect(res.status).toBe(204);
  });
});
