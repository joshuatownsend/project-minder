/**
 * How to test a Next.js App Router route handler under Vitest
 * ============================================================
 *
 * RECIPE (3 steps):
 *
 *   1. Mock lib boundaries at the top of the test file, BEFORE any imports of
 *      the route:
 *
 *        vi.mock("@/lib/cache", () => ({ getCachedScan: vi.fn(), setCachedScan: vi.fn() }));
 *        vi.mock("@/lib/scanner", () => ({ scanAllProjects: vi.fn() }));
 *
 *   2. Import the handler after the mocks, and build a request with params:
 *
 *        import { GET } from "@/app/api/projects/route";
 *
 *        // For routes with dynamic [slug] params, pass a params promise:
 *        const params = { params: Promise.resolve({ slug: "my-project" }) };
 *        const req = new Request("http://localhost/api/dev-server/my-project", {
 *          method: "POST",
 *          headers: { "Content-Type": "application/json" },
 *          body: JSON.stringify({ action: "stop" }),
 *        });
 *
 *   3. Call the handler and inspect the response:
 *
 *        const res = await GET(req, params);  // or POST, etc.
 *        expect(res.status).toBe(200);
 *        const body = await res.json();
 *        expect(body).toMatchObject({ ... });
 *
 * NOTES:
 * - `next/server` (NextRequest, NextResponse) resolves fine under Vitest's node
 *   environment — no special stub needed beyond the existing `server-only` alias.
 * - `NextResponse.json()` and `new NextResponse()` are fully usable in tests.
 * - For GET routes without params, call `await GET()` — the handler ignores the
 *   argument when it doesn't need it.
 * - Use typed mocks: `import { getCachedScan } from "@/lib/cache";` then
 *   `vi.mocked(getCachedScan).mockReturnValue(...)`.
 * - When a route uses NextRequest-specific APIs (like `request.nextUrl`), pass a
 *   `NextRequest` instance instead of a plain `Request`:
 *
 *        import { NextRequest } from "next/server";
 *        const req = new NextRequest("http://localhost/api/usage?period=7d");
 */

// Re-export nothing — this file is documentation + types only.
export {};
