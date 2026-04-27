import { encodePath, toSlug } from "@/lib/scanner/claudeConversations";

/**
 * Converts a scanner project path (e.g. "C:\dev\project-minder") to the
 * slug format used by the usage parser (e.g. "dev-project-minder").
 *
 * The usage parser derives slugs from encoded Claude session dir names
 * (C--dev-project-minder → dev-project-minder via toSlug). This function
 * produces the same result starting from the raw project path.
 */
export function pathToUsageSlug(projectPath: string): string {
  return toSlug(encodePath(projectPath));
}
