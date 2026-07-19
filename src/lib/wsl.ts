import { execFile } from "child_process";
import { promises as fs } from "fs";

/** Manual promise wrapper (rather than util.promisify) so tests can mock
 *  child_process.execFile with a plain callback fn — promisify's {stdout}
 *  shape relies on a promisify.custom symbol a mock wouldn't carry. */
function runWsl(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "wsl.exe",
      args,
      { encoding: "buffer", timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as Buffer);
      }
    );
  });
}

/**
 * WSL distro probing for UNC scan roots (\\wsl.localhost\<distro>\...).
 *
 * The one hard rule here: NEVER touch a \\wsl.localhost\ path belonging to a
 * stopped distro — the 9p filesystem bridge auto-starts the distro's VM
 * (~1-2 GB RAM until idle shutdown). All availability decisions are made from
 * `wsl.exe -l -v` output alone, which reports state without waking anything.
 */

export interface WslDistro {
  name: string;
  /** "Running" | "Stopped" (verbatim from wsl.exe; other states pass through) */
  state: string;
  /** WSL version (1 or 2); 0 when unparseable */
  version: number;
  isDefault: boolean;
}

export type WslRootCheck =
  | { ok: true; distro: string }
  | { ok: false; distro: string; reason: "wsl-stopped" | "wsl-distro-not-found" | "wsl-unavailable" };

/**
 * Thrown by choke points (e.g. `canonicalProjectDir`) when an operation
 * targets a path under a WSL distro that isn't running. Routes catch it and
 * map to 503 so the UI shows an actionable message instead of a generic 500.
 */
export class WslUnavailableError extends Error {
  readonly distro: string;
  readonly reason: string;
  constructor(check: Extract<WslRootCheck, { ok: false }>) {
    super(
      `WSL distro '${check.distro}' is not running (${check.reason}) — ` +
        `Minder never wakes a stopped distro. Start it and retry.`
    );
    this.name = "WslUnavailableError";
    this.distro = check.distro;
    this.reason = check.reason;
  }
}

/**
 * Matches both UNC hosts WSL exposes (`\\wsl.localhost\...`, legacy `\\wsl$\...`),
 * tolerating forward slashes since users may paste either form. The distro
 * segment is everything up to the next separator — registered distro names can
 * contain spaces (parseWslDistroList supports them), and under-matching here
 * would make the scanner treat the root as non-WSL and touch it, waking the VM.
 * Deliberately unambiguous (greedy segment, no overlapping `\s*`) so it stays
 * linear on adversarial many-space inputs (CodeQL js/polynomial-redos);
 * trailing whitespace in the captured name is trimmed in code instead.
 */
const WSL_UNC_RE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/]|$)/i;

/** Parse a UNC path into its WSL distro name, or null for non-WSL paths. */
export function parseWslUncPath(p: string): { distro: string } | null {
  const m = WSL_UNC_RE.exec(p.trim());
  if (!m) return null;
  const distro = m[1].trim();
  return distro ? { distro } : null;
}

/**
 * wsl.exe writes UTF-16LE to stdout (with interspersed NULs if read as utf8).
 * Decode from the raw buffer: a BOM or embedded NUL bytes mean UTF-16LE;
 * otherwise assume it's already UTF-8 (some environments re-encode).
 */
export function decodeWslOutput(buf: Buffer): string {
  const isUtf16 =
    (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) || buf.includes(0);
  const text = isUtf16 ? buf.toString("utf16le") : buf.toString("utf8");
  return text.replace(/^﻿/, "");
}

/**
 * Parse `wsl.exe -l -v` output:
 *
 *       NAME              STATE           VERSION
 *     * Ubuntu-26.04      Running         2
 *       docker-desktop    Stopped         2
 *
 * Column widths vary with name length, so split on whitespace instead of
 * fixed offsets. The header row is dropped by requiring a numeric VERSION.
 */
export function parseWslDistroList(text: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, "").trim();
    if (!line) continue;
    const isDefault = line.startsWith("*");
    const parts = (isDefault ? line.slice(1) : line).trim().split(/\s+/);
    if (parts.length < 3) continue;
    const version = Number(parts[parts.length - 1]);
    if (!Number.isInteger(version)) continue; // header or malformed row
    const state = parts[parts.length - 2];
    const name = parts.slice(0, -2).join(" ");
    if (!name) continue;
    distros.push({ name, state, version, isDefault });
  }
  return distros;
}

interface WslCache {
  distros: WslDistro[] | null; // null = wsl.exe unavailable/errored
  fetchedAt: number;
}

// globalThis so dev-server HMR reloads of this module share one cache.
const g = globalThis as typeof globalThis & { __minderWslCache?: WslCache };

/**
 * Asymmetric TTLs. A cached "everything relevant is Running" answer is what
 * lets a background caller touch a distro the user just shut down — so
 * positive state is only trusted for a few seconds (long enough to dedupe the
 * wsl.exe spawns within one scan/watch cycle), while negative/unavailable
 * state (where the failure mode is merely "skipped one extra cycle") keeps
 * the longer TTL. Note the guarantee is inherently best-effort: a distro can
 * stop between a fresh check and the caller's fs access (TOCTOU) — the TTLs
 * bound the accidental-wake window, they can't eliminate it.
 */
const WSL_CACHE_TTL_RUNNING_MS = 5_000;
const WSL_CACHE_TTL_MS = 30_000;

/**
 * List WSL distros with their running state. Returns null when WSL isn't
 * usable here (non-Windows, wsl.exe missing, or WSL errored). Never throws.
 */
export async function listWslDistros(): Promise<WslDistro[] | null> {
  if (process.platform !== "win32") return null;
  const cached = g.__minderWslCache;
  if (cached) {
    // Any Running distro in the snapshot makes it a "positive" answer that
    // could green-light a UNC access — trust it only for the short TTL.
    const ttl = cached.distros?.some((d) => d.state === "Running")
      ? WSL_CACHE_TTL_RUNNING_MS
      : WSL_CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.distros;
  }
  let distros: WslDistro[] | null;
  try {
    // encoding:"buffer" so we can UTF-16-decode ourselves.
    const stdout = await runWsl(["-l", "-v"]);
    distros = parseWslDistroList(decodeWslOutput(stdout));
  } catch {
    // wsl.exe missing, WSL not enabled, or no distros installed (exit 1).
    distros = null;
  }
  g.__minderWslCache = { distros, fetchedAt: Date.now() };
  return distros;
}

/**
 * Drop the cached distro list so the next check re-runs `wsl.exe -l -v`.
 * Called on USER-INITIATED paths (Detect WSL, manual rescan): a user who just
 * started a distro shouldn't wait out the 30s negative TTL to see it Running.
 * Safe w.r.t. never-wake — a fresh listing is still a state query only.
 * Also used as a test hook.
 */
export function clearWslCache(): void {
  g.__minderWslCache = undefined;
}

export interface WslDistroSuggestion {
  name: string;
  state: string;
  isDefault: boolean;
  /** Existing `\\wsl.localhost\<distro>\home\<user>\dev` dirs — scan-root candidates. */
  suggestedRoots: string[];
  /** Existing `\\wsl.localhost\<distro>\home\<user>\.claude` dirs (consumed by the
   *  multi-home session work; surfaced now so detection is one probe). */
  claudeHomes: string[];
}

export interface WslDiscovery {
  /** false = not Windows, wsl.exe missing, or WSL errored. */
  available: boolean;
  distros: WslDistroSuggestion[];
}

/** Utility VM distros with no user filesystem worth scanning. */
const IGNORED_DISTROS = /^docker-desktop/i;

/**
 * Enumerate distros and, for RUNNING ones only, probe their /home/<user>
 * dirs for `dev` and `.claude` candidates. Stopped distros are listed but
 * never touched (listing comes from wsl.exe, which doesn't wake them);
 * starting them is the user's call.
 */
export async function discoverWslSuggestions(): Promise<WslDiscovery> {
  const distros = await listWslDistros();
  if (distros === null) return { available: false, distros: [] };

  const suggestions: WslDistroSuggestion[] = [];
  for (const d of distros) {
    if (IGNORED_DISTROS.test(d.name)) continue;
    const entry: WslDistroSuggestion = {
      name: d.name,
      state: d.state,
      isDefault: d.isDefault,
      suggestedRoots: [],
      claudeHomes: [],
    };
    if (d.state === "Running") {
      const homeRoot = `\\\\wsl.localhost\\${d.name}\\home`;
      try {
        const users = (await fs.readdir(homeRoot, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        for (const user of users) {
          const devDir = `${homeRoot}\\${user}\\dev`;
          const claudeDir = `${homeRoot}\\${user}\\.claude`;
          if (await isDir(devDir)) entry.suggestedRoots.push(devDir);
          if (await isDir(claudeDir)) entry.claudeHomes.push(claudeDir);
        }
      } catch {
        // /home unreadable (minimal distro, permissions) — list with no suggestions.
      }
    }
    suggestions.push(entry);
  }
  return { available: true, distros: suggestions };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Route-level never-wake preflight: returns the failing WslRootCheck for the
 * first supplied path that sits under a non-running WSL distro, or null when
 * every path is safe to touch (non-WSL paths are always safe). Sync-parses
 * first so all-local calls cost nothing.
 */
export async function firstBlockedWslPath(
  ...paths: (string | undefined)[]
): Promise<Extract<WslRootCheck, { ok: false }> | null> {
  for (const p of paths) {
    if (!p || !parseWslUncPath(p)) continue;
    const check = await checkWslRoot(p);
    if (check && !check.ok) return check;
  }
  return null;
}

/**
 * Decide whether a WSL UNC root may be read right now. Callers must invoke
 * this BEFORE any fs operation on the root (the fs call is what wakes the VM).
 * Non-WSL paths return ok so callers can guard unconditionally.
 */
export async function checkWslRoot(root: string): Promise<WslRootCheck | null> {
  const parsed = parseWslUncPath(root);
  if (!parsed) return null;
  const distros = await listWslDistros();
  if (distros === null) {
    return { ok: false, distro: parsed.distro, reason: "wsl-unavailable" };
  }
  const match = distros.find(
    (d) => d.name.toLowerCase() === parsed.distro.toLowerCase()
  );
  if (!match) {
    return { ok: false, distro: parsed.distro, reason: "wsl-distro-not-found" };
  }
  if (match.state !== "Running") {
    return { ok: false, distro: parsed.distro, reason: "wsl-stopped" };
  }
  return { ok: true, distro: parsed.distro };
}
