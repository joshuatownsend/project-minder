import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import {
  attachControlChannel,
  shouldEnableControlChannel,
  CONTROL_SHUTDOWN_COMMAND,
  _resetControlChannelForTesting,
} from "@/lib/controlChannel";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetControlChannelForTesting();
  // Silence the serviceLog console tee.
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("shouldEnableControlChannel gating", () => {
  it("enables only for the exact string '1'", () => {
    expect(shouldEnableControlChannel({ MINDER_CONTROL_STDIN: "1" })).toBe(true);
  });

  it("is inert when unset", () => {
    expect(shouldEnableControlChannel({})).toBe(false);
  });

  it("is inert for other truthy-looking values", () => {
    expect(shouldEnableControlChannel({ MINDER_CONTROL_STDIN: "true" })).toBe(false);
    expect(shouldEnableControlChannel({ MINDER_CONTROL_STDIN: "0" })).toBe(false);
    expect(shouldEnableControlChannel({ MINDER_CONTROL_STDIN: "yes" })).toBe(false);
  });
});

describe("attachControlChannel parsing", () => {
  it("requests shutdown on a 'shutdown' line", () => {
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    stream.write(`${CONTROL_SHUTDOWN_COMMAND}\n`);

    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
    expect(onShutdownRequest).toHaveBeenCalledWith("control-stdin:shutdown");
  });

  it("ignores unknown lines", () => {
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    stream.write("status\n");
    stream.write("restart\n");

    expect(onShutdownRequest).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace / CRLF before matching", () => {
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    // Windows line ending — the \r must be trimmed for the match to hit.
    stream.write("  shutdown \r\n");

    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
    expect(onShutdownRequest).toHaveBeenCalledWith("control-stdin:shutdown");
  });

  it("buffers a command split across chunk boundaries", () => {
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    stream.write("shut");
    expect(onShutdownRequest).not.toHaveBeenCalled();
    stream.write("down\n");

    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
  });

  it("does not fire on a partial line with no newline", () => {
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    stream.write("shutdown"); // no newline yet

    expect(onShutdownRequest).not.toHaveBeenCalled();
  });

  it("handles multiple commands in a single chunk", () => {
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    stream.write("noop\nshutdown\n");

    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
    expect(onShutdownRequest).toHaveBeenCalledWith("control-stdin:shutdown");
  });

  it("accepts Buffer chunks (no prior setEncoding)", () => {
    // A bare EventEmitter-style stream without setEncoding still works.
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    stream.write(Buffer.from("shutdown\n", "utf8"));

    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
  });

  it("requests shutdown on stream end (EOF / pipe close)", async () => {
    const stream = new PassThrough();
    const onShutdownRequest = vi.fn();
    attachControlChannel(stream, { onShutdownRequest });

    // `end` is emitted asynchronously once the readable side drains — wait for it.
    const ended = new Promise<void>((resolve) => stream.once("end", () => resolve()));
    stream.end(); // supervisor closed the pipe
    await ended;

    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
    expect(onShutdownRequest).toHaveBeenCalledWith("control-stdin:eof");
  });
});

describe("attachControlChannel wired to the real shutdown path", () => {
  it("a 'shutdown' line drives lifecycle.shutdown() once, honoring isShuttingDown()", async () => {
    const lifecycle = await import("@/lib/lifecycle");
    lifecycle._resetLifecycleForTesting();

    const disposer = vi.fn();
    lifecycle.onShutdown("test-disposer", disposer);

    const stream = new PassThrough();
    // Mirror initControlChannel's handler, minus the real process.exit(0).
    attachControlChannel(stream, {
      onShutdownRequest: (reason) => {
        if (lifecycle.isShuttingDown()) return;
        void lifecycle.shutdown(reason);
      },
    });

    stream.write("shutdown\n");
    // A trailing EOF must not double-run — shutdown() is already in flight.
    stream.end();

    // Let the memoized shutdown promise settle.
    await lifecycle.shutdown("await-settle");

    expect(disposer).toHaveBeenCalledTimes(1);
    expect(lifecycle.isShuttingDown()).toBe(true);

    lifecycle._resetLifecycleForTesting();
  });
});
