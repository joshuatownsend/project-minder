import { describe, it, expect, vi } from "vitest";
import type { SessionSummary } from "@/lib/types";

// Everything in the sessions cache slot is sent to the browser (`/api/sessions`
// and the RSC prefetch). The file parse and demo fixtures still fill
// `searchableText` for the server's search fallback; it must not ride along,
// since it was 13 MB of a 34 MB response (#700).

vi.mock("@/lib/data", () => ({ getSessionsList: vi.fn() }));
vi.mock("@/lib/demo/demoMode", () => ({ demoMode: vi.fn(async () => false) }));
vi.mock("@/lib/config", () => ({ readConfig: vi.fn(async () => ({})) }));

import { getSessionsList } from "@/lib/data";
import { getSessionsCacheSlot } from "@/lib/server/queries/sessions";

describe("sessions cache slot", () => {
  it("drops searchableText before the list is cached for the browser", async () => {
    delete (globalThis as Record<string, unknown>).__sessionsCache;
    vi.mocked(getSessionsList).mockResolvedValue({
      sessions: [
        { sessionId: "a", searchableText: "x".repeat(4000) } as SessionSummary,
        { sessionId: "b" } as SessionSummary,
      ],
      meta: { backend: "file", maxMtimeMs: 0 },
    });
    const slot = await getSessionsCacheSlot();
    expect(slot.result.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    for (const s of slot.result.sessions) expect("searchableText" in s).toBe(false);
    expect(JSON.stringify(slot.result.sessions)).not.toContain("xxxx");
    expect(slot.result.meta.backend).toBe("file");
  });
});
