import { NextRequest, NextResponse } from "next/server";
import { decideApproval, type ApprovalDecision } from "@/lib/approvals/store";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";

// `POST /api/approvals/[id]` — record a human decision on a blocked tool
// call. Body: `{ "decision": "allow" | "allow_all" | "deny" }`.
//
// **409 on a request that is no longer pending is the replay-safety
// property, not an edge case.** `decideApproval` returns false for an id
// that already resolved, already timed out, or never existed, and that is
// reported honestly rather than as a success. Without it, tapping a stale
// phone notification minutes later would silently approve whatever
// unrelated tool call happened to be waiting — the failure mode is not "a
// wasted click", it is "the wrong thing got approved".
export const dynamic = "force-dynamic";

const DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>([
  "allow",
  "allow_all",
  "deny",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Demo mode is read-only everywhere else; an approval is a real
  // side-effecting decision on a real session.
  const blocked = await demoWriteBlock();
  if (blocked) return blocked;

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const decision = body.decision;
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    return NextResponse.json(
      { error: `decision must be one of: ${[...DECISIONS].join(", ")}` },
      { status: 400 }
    );
  }

  const applied = decideApproval(id, decision as ApprovalDecision);
  if (!applied) {
    return NextResponse.json(
      {
        error: "This request is no longer waiting for a decision",
        reason: "not-pending",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, id, decision });
}
