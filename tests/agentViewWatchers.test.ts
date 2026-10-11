import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #657: Agent View's watchers run only while an SSE client is connected. These
// pin the reference count: the last release starts a grace period, a new
// subscriber cancels it, and a doubled release is counted once.

vi.mock("@/lib/agentView/jobRoster", () => ({
  startJobRosterWatcher: vi.fn(),
  stopJobRosterWatcher: vi.fn(),
}));
vi.mock("@/lib/agentView/jsonlWatcher", () => ({
  startJsonlWatcher: vi.fn(),
  stopJsonlWatcher: vi.fn(),
}));

import { startJobRosterWatcher, stopJobRosterWatcher } from "@/lib/agentView/jobRoster";
import { startJsonlWatcher, stopJsonlWatcher } from "@/lib/agentView/jsonlWatcher";
import {
  acquireAgentViewWatchers,
  _agentViewSubscriberCountForTesting as agentViewSubscriberCount,
  GRACE_MS,
  _resetAgentViewWatchersForTesting,
} from "@/lib/agentView/agentViewWatchers";

function stopped(): boolean {
  const roster = vi.mocked(stopJobRosterWatcher).mock.calls.length;
  const jsonl = vi.mocked(stopJsonlWatcher).mock.calls.length;
  expect(roster).toBe(jsonl);
  return jsonl > 0;
}

describe("acquireAgentViewWatchers (#657)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetAgentViewWatchersForTesting();
  });
  afterEach(() => {
    _resetAgentViewWatchersForTesting();
    vi.useRealTimers();
  });

  it("starts both watchers for a subscriber", () => {
    acquireAgentViewWatchers();
    expect(startJobRosterWatcher).toHaveBeenCalledTimes(1);
    expect(startJsonlWatcher).toHaveBeenCalledTimes(1);
    expect(agentViewSubscriberCount()).toBe(1);
  });

  it("stops both watchers only after the grace period once the last subscriber leaves", () => {
    const release = acquireAgentViewWatchers();
    release();
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(stopped()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(stopped()).toBe(true);
  });

  it("keeps running while another subscriber remains", () => {
    const a = acquireAgentViewWatchers();
    acquireAgentViewWatchers();
    a();
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(stopped()).toBe(false);
    expect(agentViewSubscriberCount()).toBe(1);
  });

  it("a subscriber arriving during the grace period cancels the stop", () => {
    acquireAgentViewWatchers()();
    vi.advanceTimersByTime(GRACE_MS / 2);
    acquireAgentViewWatchers();
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(stopped()).toBe(false);
  });

  it("releasing the same subscriber twice counts once", () => {
    const a = acquireAgentViewWatchers();
    acquireAgentViewWatchers();
    a();
    a();
    expect(agentViewSubscriberCount()).toBe(1);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(stopped()).toBe(false);
  });

  it("restarts the watchers for a subscriber after a stop", () => {
    acquireAgentViewWatchers()();
    vi.advanceTimersByTime(GRACE_MS);
    expect(stopped()).toBe(true);
    acquireAgentViewWatchers();
    expect(startJsonlWatcher).toHaveBeenCalledTimes(2);
    expect(startJobRosterWatcher).toHaveBeenCalledTimes(2);
  });
});
