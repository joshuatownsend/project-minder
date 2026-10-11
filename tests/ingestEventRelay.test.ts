import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

// #657: ingest's post-commit events fire on the ingest worker's own buses,
// where nothing listens. The worker relays them (`relayBusEvents`) and the host
// re-emits them (`absorbWorkerMessage` → `reemitRelayedEvent`). Both halves run
// in this one isolate here, so the relay is disposed before the host half
// re-emits — otherwise the re-emit would be relayed again.

vi.mock("@/lib/serviceLog", () => ({ serviceLog: vi.fn() }));

import { relayBusEvents } from "@/lib/events/workerRelay";
import { absorbWorkerMessage } from "@/lib/db/workerHost";
import * as agentBus from "@/lib/agentView/eventBus";
import * as minderBus from "@/lib/events/bus";

const hostState = () => ({ memory: null, watcher: null }) as Parameters<typeof absorbWorkerMessage>[0];

/** Collect what the main-thread buses deliver while `fn` runs. */
function listen(fn: () => void) {
  const agent: unknown[] = [];
  const minder: unknown[] = [];
  const offAgent = agentBus.onAgentEvent((e) => agent.push(e));
  const offMinder = minderBus.onMinderEvent((e) => minder.push(e));
  try {
    fn();
  } finally {
    offAgent();
    offMinder();
  }
  return { agent, minder };
}

describe("worker bus relay (#657)", () => {
  it("relays bus events and the host re-emits them on its buses", () => {
    const posted: unknown[] = [];
    const stop = relayBusEvents((m) => posted.push(m));
    agentBus.bridgeJsonlAppendToEventBus("sess-1", "my-proj");
    minderBus.emitMinderEvent("sessions.changed");
    stop();

    expect(posted).toEqual([
      { type: "agent-event", event: { kind: "jsonl-tail", sessionId: "sess-1", slug: "my-proj" } },
      { type: "minder-event", event: { type: "sessions.changed" } },
    ]);

    // Structured clone, as postMessage would deliver it.
    const got = listen(() => {
      for (const m of posted) absorbWorkerMessage(hostState(), structuredClone(m));
    });
    expect(got.agent).toEqual([{ kind: "jsonl-tail", sessionId: "sess-1", slug: "my-proj" }]);
    expect(got.minder).toEqual([{ type: "sessions.changed" }]);
  });

  it("carries every agent event kind, with its optional fields", () => {
    const hook = { kind: "hook", sessionId: "s", slug: "p", hookEventName: "PreToolUse", toolName: "Bash", message: "m" };
    const got = listen(() => absorbWorkerMessage(hostState(), { type: "agent-event", event: hook }));
    expect(got.agent).toEqual([hook]);
  });

  it("stops relaying once disposed", () => {
    const post = vi.fn();
    relayBusEvents(post)();
    agentBus.bridgeJsonlAppendToEventBus("sess-2", "p");
    expect(post).not.toHaveBeenCalled();
  });

  it("a throwing post never reaches the code that emitted the event", () => {
    const stop = relayBusEvents(() => {
      throw new Error("port closed");
    });
    expect(() => agentBus.bridgeJsonlAppendToEventBus("sess-3", "p")).not.toThrow();
    stop();
  });

  it("the host drops malformed relayed events", () => {
    const got = listen(() => {
      absorbWorkerMessage(hostState(), { type: "agent-event", event: { kind: "bogus", sessionId: "s", slug: "p" } });
      absorbWorkerMessage(hostState(), { type: "agent-event", event: { kind: "jsonl-tail", sessionId: 42, slug: "p" } });
      absorbWorkerMessage(hostState(), { type: "agent-event" });
      absorbWorkerMessage(hostState(), { type: "minder-event", event: { type: "not.a.real.event" } });
      absorbWorkerMessage(hostState(), { type: "minder-event", event: null });
    });
    expect(got.agent).toEqual([]);
    expect(got.minder).toEqual([]);
  });
});

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-ingest-notify-", preserveEnv: ["MINDER_USE_DB"] });

describe.skipIf(!driverAvailable)("ingest post-commit notification", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = state.tmpHome();
  });

  it("a full index of a session emits sessions.changed, as a tail append does", async () => {
    await state.reload();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const conn = await import("@/lib/db/connection");
    const mig = await import("@/lib/db/migrations");
    const ingest = await import("@/lib/db/ingest");
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;
    const file = path.join(tmpHome, ".claude", "projects", "C--dev-alpha", "s1.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const line = (type: string, extra: object) =>
      JSON.stringify({ type, timestamp: "2026-04-30T10:00:00Z", ...extra }) + "\n";
    await fs.writeFile(
      file,
      line("user", { message: { content: [{ type: "text", text: "hi" }] } }) +
        line("assistant", {
          message: {
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        })
    );

    const minder: unknown[] = [];
    const agent: unknown[] = [];
    // The dynamic import may have loaded fresh bus modules; both pin their
    // emitter on globalThis, so the static imports above share it.
    const offMinder = minderBus.onMinderEvent((e) => minder.push(e));
    const offAgent = agentBus.onAgentEvent((e) => agent.push(e));
    await ingest.reconcileSessionFile(db, file, "C--dev-alpha"); // first sight → full write
    offMinder();
    offAgent();

    expect(minder).toEqual([{ type: "sessions.changed" }]);
    expect(agent).toEqual([expect.objectContaining({ kind: "jsonl-tail", sessionId: "s1" })]);
  });
});
