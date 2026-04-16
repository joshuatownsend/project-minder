import { describe, it, expect, vi } from "vitest";
import { findFreePort } from "@/lib/processManager";

describe("findFreePort", () => {
  it("returns startPort when it is free", async () => {
    const checker = vi.fn().mockResolvedValue(false);
    expect(await findFreePort(4101, 10, checker)).toBe(4101);
    expect(checker).toHaveBeenCalledWith(4101);
  });

  it("skips in-use ports and returns next free one", async () => {
    const checker = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await findFreePort(4101, 10, checker)).toBe(4103);
  });

  it("returns null when all attempts exhausted", async () => {
    const checker = vi.fn().mockResolvedValue(true);
    expect(await findFreePort(4101, 3, checker)).toBeNull();
    expect(checker).toHaveBeenCalledTimes(3);
  });
});
