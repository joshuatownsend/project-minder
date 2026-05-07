import "server-only";
import { spawn } from "child_process";
import { readConfig } from "@/lib/config";
import { detectTerminal } from "./detect";

export interface LaunchResult {
  ok: boolean;
  fallback?: string;
}

export async function launchTerminal(opts: {
  cwd: string;
  command?: string;
}): Promise<LaunchResult> {
  const { cwd, command } = opts;
  const config = await readConfig();
  let termDef = await detectTerminal();

  // User override: a custom binary name replaces the detected one.
  // Only override the binary; keep the same arg-builder for the platform.
  if (config.terminal) {
    termDef = {
      binary: config.terminal,
      buildArgs: termDef.buildArgs,
    };
  }

  const args = termDef.buildArgs(cwd, command);
  const fallback = command ?? `cd "${cwd}"`;

  return new Promise((resolve) => {
    try {
      const child = spawn(termDef.binary, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.unref();
      child.on("error", () => resolve({ ok: false, fallback }));
      // Give the process a moment to fail. If it doesn't error within 500ms
      // we optimistically report ok — the terminal is running.
      setTimeout(() => resolve({ ok: true }), 500);
    } catch {
      resolve({ ok: false, fallback });
    }
  });
}
