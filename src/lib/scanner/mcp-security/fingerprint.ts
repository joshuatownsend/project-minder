import { createHash } from "crypto";
import type { McpToolFingerprint } from "../../types";

/** Stable SHA-256 hex digest of arbitrary text. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface FingerprintDiff {
  added: string[];   // tool_names new in curr
  removed: string[]; // tool_names absent from curr
  changed: string[]; // tool_names present in both but hash differs
}

/**
 * Diff two fingerprint snapshots keyed by tool_name.
 * prev = what was last stored; curr = what the live scan just produced.
 */
export function diffFingerprints(
  prev: Map<string, McpToolFingerprint>,
  curr: Map<string, McpToolFingerprint>,
): FingerprintDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, currFp] of curr) {
    const prevFp = prev.get(key);
    if (!prevFp) {
      added.push(currFp.toolName);
    } else if (prevFp.descriptionHash !== currFp.descriptionHash) {
      changed.push(currFp.toolName);
    }
  }

  for (const [key, prevFp] of prev) {
    if (!curr.has(key)) removed.push(prevFp.toolName);
  }

  return { added, removed, changed };
}
