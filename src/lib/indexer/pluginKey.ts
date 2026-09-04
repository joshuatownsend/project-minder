/**
 * The registry key for a plugin: `name@marketplace`, or the bare name when the
 * registry key had no marketplace segment (`loadInstalledPlugins` parses that
 * as `marketplace: ""`). Appending `@` unconditionally produced `foo@`, which
 * matches nothing (Copilot on #555).
 *
 * Its own module, with no imports, because the client hook that builds
 * Environments rows (`src/hooks/useHomeCatalogs.ts`) needs it too and
 * `walkPlugins.ts` pulls in `fs`.
 */
export function pluginRegistryKey(pluginName: string, marketplace: string | undefined): string {
  return marketplace ? `${pluginName}@${marketplace}` : pluginName;
}
