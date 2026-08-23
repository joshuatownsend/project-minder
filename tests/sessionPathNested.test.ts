import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

/**
 * `resolveSessionJsonl` and nested subagent transcripts (#484).
 *
 * #483 widened the session-id gate so `agent-<hex>` ids stop being rejected.
 * Both reviewers pointed out the same consequence: the DB-backed detail route
 * serves from indexed columns and so started working, but every per-session
 * endpoint that reads the transcript OFF DISK resolves through this function —
 * `/quality`, `/handoff`, `/context-attribution`, and the network/delegation
 * routes — and it only probed `<projects>/<dir>/<id>.jsonl`.
 *
 * A gate that admits an id the resolver cannot find does not fix anything; it
 * converts "invalid id" into "not found". These cases pin the nested probe that
 * closes that gap.
 */
const state = installIsolatedState({ prefix: "pm-sessionpath-" });

let tmpHome: string;
beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function writeTranscript(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ type: "user", timestamp: "2026-04-15T10:00:00Z" }) + "\n");
}

describe("resolveSessionJsonl — nested subagent transcripts", () => {
  const PARENT = "abcdef00-1111-2222-3333-444455556666";
  const AGENT = "agent-a38db58938dbeea68";

  it("finds a transcript under <project>/<parent>/subagents/", async () => {
    await state.reload();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeTranscript(
      path.join(projectsDir, "C--dev-app-x", PARENT, "subagents", `${AGENT}.jsonl`)
    );

    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    const found = await resolveSessionJsonl(AGENT);

    expect(found).not.toBeNull();
    expect(found!.filePath.endsWith(`${AGENT}.jsonl`)).toBe(true);
    // The PROJECT dir, not the parent-session dir — matching how ingest
    // attributes these files, so both backends agree on which project a
    // subagent session belongs to.
    expect(found!.projectDirName).toBe("C--dev-app-x");
  });

  it("still prefers a top-level transcript over a nested one", async () => {
    // Ordering guard. The flat pass must stay first: it is the common case, and
    // the nested walk costs a readdir per project directory. If a future edit
    // reorders them this fails rather than silently getting slower.
    await state.reload();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const ID = "beefcafe-0000-1111-2222-333344445555";
    await writeTranscript(path.join(projectsDir, "C--dev-app-x", `${ID}.jsonl`));
    await writeTranscript(
      path.join(projectsDir, "C--dev-app-x", PARENT, "subagents", `${ID}.jsonl`)
    );

    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    const found = await resolveSessionJsonl(ID);

    expect(found).not.toBeNull();
    expect(path.dirname(found!.filePath)).toBe(path.join(projectsDir, "C--dev-app-x"));
  });

  it("returns null for an id that exists nowhere", async () => {
    // Premise for the cases above: absence still reads as absence, so a passing
    // result there means the nested probe found something rather than that the
    // resolver started answering optimistically.
    await state.reload();
    await fs.mkdir(path.join(tmpHome, ".claude", "projects", "C--dev-app-x"), {
      recursive: true,
    });

    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    expect(await resolveSessionJsonl("agent-000000000000000ff")).toBeNull();
  });

  it("does not walk the nested layout for a non-agent id (documented limit)", async () => {
    // Pins the optimization guard, and its cost. The nested walk is gated on
    // the `agent-` prefix because running it on every miss put a 1.4s readdir
    // sweep and 3,279 `access` calls in front of every unresolvable id —
    // measured on a reference tree of 80 project dirs, of whose 3,279 session
    // subdirectories only 127 hold a `subagents/` directory. That is the
    // ordinary 404 path for any bad session URL, and it timed out a test at 30s
    // under parallel load.
    //
    // So this asserts a LIMITATION, deliberately: a nested transcript not named
    // `agent-*` is not found. Being wrong in that direction costs nothing new —
    // such a file did not resolve before the nested probe existed either —
    // whereas being wrong the other way regresses the common path. If Claude
    // Code ever stops using the prefix, this test is where that shows up.
    await state.reload();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const ID = "deadbeef-0000-1111-2222-333344445555";
    await writeTranscript(
      path.join(projectsDir, "C--dev-app-x", PARENT, "subagents", `${ID}.jsonl`)
    );

    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    expect(await resolveSessionJsonl(ID)).toBeNull();
  });

  it("rejects a path-traversal id before touching the filesystem", async () => {
    await state.reload();
    const { resolveSessionJsonl } = await import("@/lib/usage/sessionPath");
    expect(await resolveSessionJsonl("../../../etc/passwd")).toBeNull();
  });
});
