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
 * Matches both UNC hosts WSL exposes (`\\wsl.localhost\...`, legacy `\\wsl$\...`),
 * tolerating forward slashes since users may paste either form.
 * Distro names: word chars, dots, dashes (e.g. "Ubuntu-26.04").
 */
const WSL_UNC_RE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([\w.-]+)(?:[\\/]|$)/i;

/** Parse a UNC path into its WSL distro name, or null for non-WSL paths. */
export function parseWslUncPath(p: string): { distro: string } | null {
  const m = WSL_UNC_RE.exec(p.trim());
  return m ? { distro: m[1] } : null;
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

/** Short TTL: distro state changes when the user starts/stops WSL; a scan
 *  cycle hitting several WSL roots should still spawn wsl.exe only once. */
const WSL_CACHE_TTL_MS = 30_000;

/**
 * List WSL distros with their running state. Returns null when WSL isn't
 * usable here (non-Windows, wsl.exe missing, or WSL errored). Never throws.
 */
export async function listWslDistros(): Promise<WslDistro[] | null> {
  if (process.platform !== "win32") return null;
  const cached = g.__minderWslCache;
  if (cached && Date.now() - cached.fetchedAt < WSL_CACHE_TTL_MS) {
    return cached.distros;
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

/** Test hook: drop the cached distro list. */
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
