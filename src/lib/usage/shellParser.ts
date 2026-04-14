import type { ShellStats } from "@/lib/usage/types";

/**
 * Extracts the binary name from a shell command string.
 *
 * Steps:
 * 1. Trim whitespace
 * 2. If starts with `npx ` or `npx -y `, return the next token (the package name)
 * 3. If starts with `sudo `, strip it and continue
 * 4. Split on pipe `|` — take only the first segment
 * 5. Split on `&&` or `||` — take only the first segment
 * 6. If starts with a quoted path (single or double quotes), extract the path, return basename without extension
 * 7. If starts with `& "` (PowerShell call operator), strip `& ` and handle the quoted path
 * 8. Split on whitespace — first token is the binary
 * 9. If the binary contains path separators (`/` or `\`), return basename without extension
 * 10. Return the binary, lowercased
 * 11. Empty/whitespace-only input returns "unknown"
 */
export function extractBinary(command: string): string {
  // Step 1: Trim whitespace
  let str = command.trim();

  // Step 11: Empty/whitespace-only input returns "unknown"
  if (!str) {
    return "unknown";
  }

  // Step 3: If starts with `sudo `, strip it and continue
  if (str.startsWith("sudo ")) {
    str = str.slice("sudo ".length).trim();
  }

  // Step 2: If starts with `npx ` or `npx -y `, return the next token (the package name)
  if (str.startsWith("npx -y ")) {
    str = str.slice("npx -y ".length).trim();
    const token = str.split(/\s+/)[0];
    return token ? token.toLowerCase() : "unknown";
  }
  if (str.startsWith("npx ")) {
    str = str.slice("npx ".length).trim();
    const token = str.split(/\s+/)[0];
    return token ? token.toLowerCase() : "unknown";
  }

  // Step 4: Split on pipe `|` — take only the first segment
  str = str.split("|")[0].trim();

  // Step 5: Split on `&&` or `||` — take only the first segment
  str = str.split(/&&|\|\|/)[0].trim();

  // Step 7: If starts with `& "` (PowerShell call operator), strip `& ` and handle the quoted path
  if (str.startsWith("& ")) {
    str = str.slice("& ".length).trim();
  }

  // Step 6 & 7: If starts with a quoted path (single or double quotes), extract the path, return basename without extension
  if ((str.startsWith('"') || str.startsWith("'")) && str.length > 1) {
    const quoteChar = str[0];
    const endIndex = str.indexOf(quoteChar, 1);
    if (endIndex > 1) {
      const quotedPath = str.substring(1, endIndex);
      return getBasenameWithoutExtension(quotedPath);
    }
  }

  // Step 8: Split on whitespace — first token is the binary
  const token = str.split(/\s+/)[0];
  if (!token) {
    return "unknown";
  }

  // Special case: if token is a package runner tool and the entire remaining string is just that token,
  // it means the command is something like "npx" or "npm" with no arguments, which should be unknown
  if ((token === "npx" || token === "npm" || token === "yarn" || token === "pnpm") && str === token) {
    return "unknown";
  }

  // Step 9: If the binary contains path separators (`/` or `\`), return basename without extension
  if (token.includes("/") || token.includes("\\")) {
    return getBasenameWithoutExtension(token);
  }

  // Step 10: Return the binary, lowercased
  return token.toLowerCase();
}

/**
 * Get the basename of a path without extension.
 * Example: "C:\\Program Files\\node.exe" => "node"
 */
function getBasenameWithoutExtension(path: string): string {
  // Get basename (last segment after / or \)
  const parts = path.split(/[\/\\]/);
  const basename = parts[parts.length - 1];

  // Remove extension
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex > 0) {
    return basename.substring(0, dotIndex).toLowerCase();
  }

  return basename.toLowerCase();
}

/**
 * Groups commands by binary name and sorts descending by count.
 */
export function groupByBinary(commands: string[]): ShellStats[] {
  const map = new Map<string, number>();

  for (const command of commands) {
    const binary = extractBinary(command);
    map.set(binary, (map.get(binary) ?? 0) + 1);
  }

  return Array.from(map.entries())
    .map(([binary, count]) => ({ binary, count }))
    .sort((a, b) => b.count - a.count);
}
