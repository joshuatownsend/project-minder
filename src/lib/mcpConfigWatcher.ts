import { promises as fs, watch, FSWatcher } from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import { tryParseJsonc } from "./scanner/util/jsonc";
import { invalidateUserConfigCache } from "./userConfigCache";
import { mcpHealthCache } from "./mcpHealthCache";

/**
 * MCP Config Watcher — makes the top-bar MCP health strip drop an
 * externally-removed server *immediately* instead of waiting out the shared
 * `getUserConfig()` 5-minute cache (the Codex round-4 follow-up). It watches the
 * user-scope MCP config files and calls `invalidateUserConfigCache()` when — and
 * ONLY when — the `mcpServers` slice actually changes.
 *
 * The "only when it changes" guard is essential: `~/.claude.json` is Claude
 * Code's live runtime-state file and is rewritten constantly (session state,
 * telemetry, …). Invalidating on every write would thrash the config cache and
 * force the full multi-source re-read (including the O(installed-plugins)
 * registry walk) on the next poll — exactly the per-poll cost we rejected. So on
 * each debounced event we re-derive a signature of just the `mcpServers` block
 * and invalidate only if it differs from the last-seen one.
 *
 * Scope: the two user-scope sources most likely to be hand-edited — the
 * top-level `mcpServers` in `~/.claude.json` and `~/.claude/settings.json`.
 * Changes to Desktop/plugin/managed sources still surface within the 5-min TTL.
 */

const DEBOUNCE_MS = 400;

/**
 * Canonicalize one server definition for the signature: sort its top-level keys
 * (so a rewrite that reorders `command`/`env`/… doesn't look like a change) and
 * — critically — reduce any `env` block to its sorted KEY NAMES. The values in
 * `env` may be credentials; like every other MCP reader in the codebase, the
 * watcher must never retain raw secret values in memory (they'd otherwise sit in
 * `lastSig` for the watcher's lifetime). `args` order is preserved — it's
 * significant for the spawned command.
 */
/** Hash of an env block (keys AND values). Lets the signature CHANGE when a
 *  secret rotates — so a fixed/rotated token forces a re-probe of the real
 *  stdio handshake — WITHOUT ever embedding the raw value: only the digest is
 *  retained. Sorted, so key order is stable. */
function hashEnvBlock(env: Record<string, unknown>): string {
  const entries = Object.entries(env)
    .filter(([, v]) => typeof v === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v as string}`);
  return "sha256:" + createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
}

function normalizeServerDef(def: unknown): unknown {
  if (!def || typeof def !== "object") return def ?? null;
  const obj = def as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (key === "env" && val && typeof val === "object" && !Array.isArray(val)) {
      // Hash (keys + values) rather than raw values: a rotated secret changes
      // the signature (forcing a re-probe) but is never stored in cleartext.
      out.env = hashEnvBlock(val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Signature of the `mcpServers` slice of a config document. Pure + testable.
 * Returns a stable string that changes iff the set/definition of MCP servers
 * changes — including a rotated `env` value (which flips a real handshake
 * verdict) — but NOT when unrelated runtime-state fields change or keys are
 * reordered. Env values are HASHED, never embedded, so secrets stay out of
 * `lastSig`. A missing/unparseable slice collapses to a sentinel so a broken
 * write doesn't look like a change every time.
 */
export function mcpServersSignature(rawJson: string): string {
  const doc = tryParseJsonc<{ mcpServers?: unknown }>(rawJson);
  const servers = doc?.mcpServers;
  if (!servers || typeof servers !== "object") return "∅";
  // Sort server names so insertion order (which Claude Code may rewrite)
  // doesn't register as a change; normalize each definition (env → keys).
  const entries = Object.entries(servers as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) => [name, normalizeServerDef(def)]);
  return JSON.stringify(entries);
}

class McpConfigWatcher {
  private watchers: FSWatcher[] = [];
  private lastSig = new Map<string, string>();
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  private targets(): string[] {
    const home = os.homedir();
    return [path.join(home, ".claude.json"), path.join(home, ".claude", "settings.json")];
  }

  /** Idempotent — safe to call on every /api/mcp-health request. */
  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (const filePath of this.targets()) void this.watchOne(filePath);
  }

  private async signatureOf(filePath: string): Promise<string> {
    try {
      return mcpServersSignature(await fs.readFile(filePath, "utf-8"));
    } catch {
      return "∅"; // file absent/unreadable — no servers from this source
    }
  }

  private async watchOne(filePath: string): Promise<void> {
    // Seed the baseline so the first real change is detected (and startup
    // writes of an unchanged slice don't fire).
    this.lastSig.set(filePath, await this.signatureOf(filePath));

    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    try {
      const w = watch(dir, (_event, filename) => {
        // Watching the parent dir catches atomic-rename replaces; filter to our
        // file (some platforms omit filename — then we can't filter, so fire).
        if (filename != null && filename !== name) return;
        const prev = this.debounce.get(filePath);
        if (prev) clearTimeout(prev);
        this.debounce.set(
          filePath,
          setTimeout(() => void this.onChange(filePath), DEBOUNCE_MS),
        );
      });
      w.on("error", () => {
        // Watch descriptor died (dir removed, etc.) — tear down so the next
        // ensureStarted() re-arms instead of running blind.
        this.dispose();
      });
      this.watchers.push(w);
    } catch {
      // Parent dir doesn't exist yet — leave started=true; the strip still works
      // off the 5-min TTL, just without instant invalidation for this source.
    }
  }

  private async onChange(filePath: string): Promise<void> {
    const sig = await this.signatureOf(filePath);
    if (sig !== this.lastSig.get(filePath)) {
      this.lastSig.set(filePath, sig);
      // The MCP server set changed — drop the shared config cache so the next
      // poll re-reads it and the strip reflects the edit immediately.
      invalidateUserConfigCache();
      // Also drop cached health verdicts so they re-probe: the config change
      // (incl. a rotated env value the real handshake depends on) can flip a
      // verdict, and the health cache's own signature only tracks env KEY names.
      mcpHealthCache.dispose();
    }
    // else: an unrelated runtime-state write — do nothing (no cache thrash).
  }

  dispose(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers = [];
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    this.lastSig.clear();
    this.started = false;
  }
}

// Singleton — persist across hot reloads in dev.
const globalForMCW = globalThis as unknown as {
  __mcpConfigWatcher?: McpConfigWatcher;
};
export const mcpConfigWatcher =
  globalForMCW.__mcpConfigWatcher || (globalForMCW.__mcpConfigWatcher = new McpConfigWatcher());
