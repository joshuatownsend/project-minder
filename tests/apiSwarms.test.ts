import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/tasks/store", () => ({
  listSwarms: vi.fn(),
  createSwarm: vi.fn(),
  getSwarm: vi.fn(),
  getSwarmTasks: vi.fn(),
}));

vi.mock("@/lib/tasks/dispatcher", () => ({
  initDispatcher: vi.fn(),
}));

import { listSwarms, createSwarm, getSwarm, getSwarmTasks } from "@/lib/tasks/store";

const mockListSwarms = vi.mocked(listSwarms);
const mockCreateSwarm = vi.mocked(createSwarm);
const mockGetSwarm = vi.mocked(getSwarm);
const mockGetSwarmTasks = vi.mocked(getSwarmTasks);

const NOW = "2026-05-09T10:00:00.000Z";

const SWARM_1 = {
  id: 1,
  name: "Test swarm",
  mode: "shared" as const,
  project_path: "C:\\dev\\test",
  status: "running" as const,
  created_at: NOW,
  completed_at: null,
};

const TASK_1 = {
  id: 10,
  title: "Member A",
  status: "pending" as const,
  swarm_id: 1,
  swarm_role: "member" as const,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockListSwarms.mockResolvedValue([]);
  mockCreateSwarm.mockResolvedValue({ swarm: SWARM_1, tasks: [TASK_1] });
  mockGetSwarm.mockResolvedValue(SWARM_1);
  mockGetSwarmTasks.mockResolvedValue([TASK_1]);
});

function mkRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const VALID_BODY = {
  name: "My swarm",
  mode: "shared",
  project_path: "C:\\dev\\my-project",
  members: [{ title: "Task A" }, { title: "Task B" }],
};

describe("GET /api/swarms", () => {
  it("returns 200 with swarms array", async () => {
    mockListSwarms.mockResolvedValue([SWARM_1]);
    const { GET } = await import("@/app/api/swarms/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.swarms)).toBe(true);
    expect(body.swarms).toHaveLength(1);
  });
});

describe("POST /api/swarms", () => {
  it("returns 201 with swarm and tasks on happy path", async () => {
    const req = mkRequest("POST", "http://localhost/api/swarms", VALID_BODY);
    const { POST } = await import("@/app/api/swarms/route");
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.swarm.id).toBe(1);
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("returns 400 when members < 2", async () => {
    const req = mkRequest("POST", "http://localhost/api/swarms", {
      ...VALID_BODY,
      members: [{ title: "Only one" }],
    });
    const { POST } = await import("@/app/api/swarms/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/2/);
  });

  it("returns 400 when members > 8", async () => {
    const req = mkRequest("POST", "http://localhost/api/swarms", {
      ...VALID_BODY,
      members: Array.from({ length: 9 }, (_, i) => ({ title: `Task ${i}` })),
    });
    const { POST } = await import("@/app/api/swarms/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/8/);
  });

  it("returns 400 when project_path is missing", async () => {
    const req = mkRequest("POST", "http://localhost/api/swarms", {
      ...VALID_BODY,
      project_path: "",
    });
    const { POST } = await import("@/app/api/swarms/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("project_path");
  });

  it("returns 400 when mode is invalid", async () => {
    const req = mkRequest("POST", "http://localhost/api/swarms", {
      ...VALID_BODY,
      mode: "parallel",
    });
    const { POST } = await import("@/app/api/swarms/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when a member title is empty", async () => {
    const req = mkRequest("POST", "http://localhost/api/swarms", {
      ...VALID_BODY,
      members: [{ title: "Valid" }, { title: "" }],
    });
    const { POST } = await import("@/app/api/swarms/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/swarms/[id]", () => {
  it("returns 200 with swarm and tasks", async () => {
    const req = mkRequest("GET", "http://localhost/api/swarms/1");
    const { GET } = await import("@/app/api/swarms/[id]/route");
    const res = await GET(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.swarm.id).toBe(1);
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("returns 404 when swarm not found", async () => {
    mockGetSwarm.mockResolvedValue(null);
    const req = mkRequest("GET", "http://localhost/api/swarms/999");
    const { GET } = await import("@/app/api/swarms/[id]/route");
    const res = await GET(req, { params: Promise.resolve({ id: "999" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-numeric id", async () => {
    const req = mkRequest("GET", "http://localhost/api/swarms/abc");
    const { GET } = await import("@/app/api/swarms/[id]/route");
    const res = await GET(req, { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/swarms/[id]/worktrees", () => {
  it("returns 204", async () => {
    const req = mkRequest("DELETE", "http://localhost/api/swarms/1/worktrees");
    const { DELETE } = await import("@/app/api/swarms/[id]/worktrees/route");
    const res = await DELETE(req, { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(204);
  });

  it("returns 400 for non-numeric id", async () => {
    const req = mkRequest("DELETE", "http://localhost/api/swarms/abc/worktrees");
    const { DELETE } = await import("@/app/api/swarms/[id]/worktrees/route");
    const res = await DELETE(req, { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(400);
  });
});
