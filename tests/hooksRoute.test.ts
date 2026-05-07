import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all server-side dependencies before importing the route
vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
}));

vi.mock("@/lib/featureFlags", () => ({
  getFlag: vi.fn(),
}));

vi.mock("@/lib/cache", () => ({
  getCachedScan: vi.fn(),
}));

vi.mock("@/lib/scanner/index", () => ({
  toSlug: vi.fn((s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
}));

vi.mock("@/lib/hooks/buffer", () => ({
  pushHookEvent: vi.fn(),
  updateLiveSession: vi.fn(),
  clearLiveSession: vi.fn(),
  setAwaiting: vi.fn().mockReturnValue(true),
  clearAwaiting: vi.fn(),
  STOP_EVENTS: new Set(["Stop", "SubagentStop", "SessionEnd"]),
}));

vi.mock("@/lib/notifications/dispatchAwaitingPermission", () => ({
  dispatchAwaitingPermission: vi.fn().mockResolvedValue(undefined),
}));

import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getCachedScan } from "@/lib/cache";
import {
  pushHookEvent,
  updateLiveSession,
  clearLiveSession,
  setAwaiting,
  clearAwaiting,
} from "@/lib/hooks/buffer";
import { dispatchAwaitingPermission } from "@/lib/notifications/dispatchAwaitingPermission";
import { POST } from "@/app/api/hooks/route";
import { NextRequest } from "next/server";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:4100/api/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseBody = {
  session_id: "test-session",
  cwd: "C:\\dev\\project-minder",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Feature flag ON by default
  (readConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ featureFlags: {} });
  (getFlag as ReturnType<typeof vi.fn>).mockReturnValue(true);
  // Scan returns a project matching our cwd
  (getCachedScan as ReturnType<typeof vi.fn>).mockReturnValue({
    projects: [
      { slug: "project-minder", path: "C:\\dev\\project-minder", name: "project-minder" },
    ],
  });
});

describe("POST /api/hooks — feature flag", () => {
  it("returns ignored when flag is off", async () => {
    (getFlag as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await POST(makeRequest(baseBody));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ignored).toBe("flag-off");
    expect(pushHookEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/hooks — validation", () => {
  it("rejects missing session_id", async () => {
    const res = await POST(makeRequest({ ...baseBody, session_id: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects missing cwd", async () => {
    const res = await POST(makeRequest({ ...baseBody, cwd: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid hook_event_name", async () => {
    const res = await POST(makeRequest({ ...baseBody, hook_event_name: "HackedEvent" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/hooks — slug resolution", () => {
  it("resolves to the matching project slug on exact path match", async () => {
    const res = await POST(makeRequest(baseBody));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.slug).toBe("project-minder");
  });

  it("resolves subdirectory to parent project slug", async () => {
    (getCachedScan as ReturnType<typeof vi.fn>).mockReturnValue({
      projects: [
        { slug: "project-minder", path: "C:\\dev\\project-minder", name: "project-minder" },
      ],
    });
    const res = await POST(makeRequest({ ...baseBody, cwd: "C:\\dev\\project-minder\\src\\lib" }));
    const json = await res.json();
    expect(json.slug).toBe("project-minder");
  });

  it("falls back to synthetic slug when no project matches", async () => {
    (getCachedScan as ReturnType<typeof vi.fn>).mockReturnValue({ projects: [] });
    const res = await POST(makeRequest({ ...baseBody, cwd: "C:\\dev\\unknown-project" }));
    const json = await res.json();
    // toSlug of basename "unknown-project"
    expect(json.slug).toBe("unknown-project");
  });

  it("uses __unknown__ when no cwd basename can be derived", async () => {
    (getCachedScan as ReturnType<typeof vi.fn>).mockReturnValue({ projects: [] });
    const res = await POST(makeRequest({ ...baseBody, cwd: "C:\\" }));
    // Should not throw, just return a slug
    expect(res.status).toBe(200);
  });
});

describe("POST /api/hooks — buffer and session state", () => {
  it("pushes event to buffer", async () => {
    await POST(makeRequest(baseBody));
    expect(pushHookEvent).toHaveBeenCalledWith("project-minder", expect.objectContaining({
      hookEventName: "PreToolUse",
      sessionId: "test-session",
    }));
  });

  it("updates live session for non-stop events", async () => {
    await POST(makeRequest(baseBody));
    expect(updateLiveSession).toHaveBeenCalledWith("test-session", "project-minder", "PreToolUse");
  });

  it("clears live session on Stop event", async () => {
    await POST(makeRequest({ ...baseBody, hook_event_name: "Stop" }));
    expect(clearLiveSession).toHaveBeenCalledWith("test-session");
    expect(updateLiveSession).not.toHaveBeenCalled();
  });

  it("clears live session on SessionEnd event", async () => {
    await POST(makeRequest({ ...baseBody, hook_event_name: "SessionEnd" }));
    expect(clearLiveSession).toHaveBeenCalledWith("test-session");
  });
});

describe("POST /api/hooks — awaiting-permission flow", () => {
  it("sets awaiting and dispatches on Notification event", async () => {
    await POST(makeRequest({ ...baseBody, hook_event_name: "Notification", message: "Approve?" }));
    expect(setAwaiting).toHaveBeenCalledWith("project-minder");
    expect(dispatchAwaitingPermission).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-minder",
      message: "Approve?",
    }));
  });

  it("does not dispatch when setAwaiting returns false (already awaiting)", async () => {
    (setAwaiting as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await POST(makeRequest({ ...baseBody, hook_event_name: "Notification" }));
    expect(dispatchAwaitingPermission).not.toHaveBeenCalled();
  });

  it("clears awaiting on non-Notification event after Notification", async () => {
    await POST(makeRequest({ ...baseBody, hook_event_name: "PreToolUse" }));
    expect(clearAwaiting).toHaveBeenCalledWith("project-minder");
  });
});
