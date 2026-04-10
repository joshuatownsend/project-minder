import { promises as fs } from "fs";
import path from "path";
import { InsightEntry } from "./types";
import { parseInsightsMd } from "./scanner/insightsMd";

/**
 * Append new insights to INSIGHTS.md in a project directory.
 *
 * @param projectPath - Full Windows path to the project
 * @param entries - Array of insight entries to append
 * @returns Number of newly appended entries (after dedup)
 *
 * Rules:
 * 1. If entries is empty, return 0
 * 2. Read existing INSIGHTS.md (or start with empty string)
 * 3. Parse existing file to get known dedup IDs
 * 4. Filter out entries whose ID is already known
 * 5. If no new entries after dedup, return 0
 * 6. Sort new entries by date descending (latest first)
 * 7. Format each entry as markdown with HTML comment marker
 * 8. Build final file: header + new entries + existing body
 * 9. Write back to INSIGHTS.md
 * 10. Return count of newly appended entries
 */
export async function appendInsights(
  projectPath: string,
  entries: InsightEntry[]
): Promise<number> {
  // 1. Early exit if no entries
  if (entries.length === 0) {
    return 0;
  }

  const insightsMdPath = path.join(projectPath, "INSIGHTS.md");

  // 2. Read existing file
  let existingContent = "";
  try {
    existingContent = await fs.readFile(insightsMdPath, "utf-8");
  } catch {
    // File doesn't exist yet, start with empty string
    existingContent = "";
  }

  // 3. Parse existing file to get known IDs
  const { knownIds } = parseInsightsMd(existingContent);

  // 4. Filter out entries whose ID is already known
  const newEntries = entries.filter((e) => !knownIds.has(e.id));

  // 5. Early exit if no new entries after dedup
  if (newEntries.length === 0) {
    return 0;
  }

  // 6. Sort new entries by date descending (latest first)
  newEntries.sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateB - dateA;
  });

  // 7. Format each entry as markdown
  const formattedEntries = newEntries.map((e) => {
    const dateStr =
      e.date && e.date !== "unknown"
        ? new Date(e.date).toISOString().slice(0, 19).replace("T", " ")
        : "unknown";

    return (
      `<!-- insight:${e.id} | session:${e.sessionId} | ${dateStr} -->\n` +
      `## ★ Insight\n` +
      `${e.content}\n` +
      `\n` +
      `---\n`
    );
  });

  const newEntriesText = formattedEntries.join("\n");

  // 8. Build final file: header + new entries + existing body
  // Strip existing "# Insights" header if present
  const existingBody = existingContent
    .replace(/^#\s+Insights\s*\n+/, "") // Remove "# Insights" header and blank lines
    .trimStart();

  const finalContent =
    `# Insights\n\n` + newEntriesText + (existingBody ? `\n${existingBody}` : "");

  // 9. Write back to INSIGHTS.md
  await fs.writeFile(insightsMdPath, finalContent, "utf-8");

  // 10. Return count of newly appended entries
  return newEntries.length;
}
