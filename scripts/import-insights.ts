import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { InsightEntry } from "../src/lib/types";
import { parseInsightsFromJsonl } from "../src/lib/scanner/insightsMd";
import { appendInsights } from "../src/lib/insightsWriter";

/**
 * Decode a Claude history directory name back to a project path.
 * Example: "C--dev-project-minder" → "C:\dev\project-minder"
 */
function decodeDirName(dirName: string): string {
  return dirName.replace(/^([A-Z])-/, "$1:").replace(/-/g, "\\");
}

/**
 * Derive a project slug from a directory name.
 * Takes the "meaningful" parts (skipping single-letter parts like drive letters)
 * and joins with hyphens, all lowercase.
 */
function toSlug(dirName: string): string {
  const parts = dirName.split("-");
  const meaningful = parts.slice(parts.findIndex((p) => p.length > 1));
  return meaningful.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

async function main() {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");

  console.log(`Scanning for Claude history in: ${claudeProjectsDir}`);
  console.log("---");

  let totalProjectsProcessed = 0;
  let totalInsightsImported = 0;
  const results: Array<{ project: string; slug: string; insights: number }> = [];

  let projectDirs: string[] = [];
  try {
    projectDirs = await fs.readdir(claudeProjectsDir);
  } catch (err) {
    console.error(`Failed to read ${claudeProjectsDir}:`, err);
    process.exit(1);
  }

  for (const dirName of projectDirs) {
    const dirPath = path.join(claudeProjectsDir, dirName);
    const stats = await fs.stat(dirPath);

    if (!stats.isDirectory()) continue;

    // Decode the directory name to get the project path
    const projectPath = decodeDirName(dirName);
    const projectSlug = toSlug(dirName);

    // Verify the project path exists on disk
    let projectExists = false;
    try {
      const projectStats = await fs.stat(projectPath);
      projectExists = projectStats.isDirectory();
    } catch {
      // Project path doesn't exist, skip
    }

    if (!projectExists) {
      console.log(`⊘ [${projectSlug}] Project path does not exist: ${projectPath}`);
      continue;
    }

    totalProjectsProcessed++;

    // Read all JSONL files in the project directory
    let jsonlFiles: string[] = [];
    try {
      const files = await fs.readdir(dirPath);
      jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    } catch (err) {
      console.log(`✗ [${projectSlug}] Failed to read directory: ${err}`);
      continue;
    }

    if (jsonlFiles.length === 0) {
      console.log(`○ [${projectSlug}] No JSONL files found`);
      results.push({ project: projectPath, slug: projectSlug, insights: 0 });
      continue;
    }

    let projectInsights = 0;

    for (const jsonlFile of jsonlFiles) {
      const jsonlPath = path.join(dirPath, jsonlFile);
      const sessionId = path.basename(jsonlFile, ".jsonl");

      // Check file size (skip > 50MB)
      let fileStats: any;
      try {
        fileStats = await fs.stat(jsonlPath);
      } catch {
        continue;
      }

      if (fileStats.size > 50 * 1024 * 1024) {
        console.log(`  ⊗ Skipping ${jsonlFile} (${(fileStats.size / 1024 / 1024).toFixed(1)}MB > 50MB)`);
        continue;
      }

      // Read and parse the JSONL file
      let jsonlContent: string;
      try {
        jsonlContent = await fs.readFile(jsonlPath, "utf-8");
      } catch (err) {
        console.log(`  ✗ Failed to read ${jsonlFile}: ${err}`);
        continue;
      }

      // Extract insights
      const insights = parseInsightsFromJsonl(jsonlContent, sessionId, projectSlug, projectPath);

      if (insights.length === 0) continue;

      // Append insights to the project
      try {
        const count = await appendInsights(projectPath, insights);
        if (count > 0) {
          console.log(`  ✓ ${jsonlFile}: imported ${count} new insight(s)`);
          projectInsights += count;
          totalInsightsImported += count;
        }
      } catch (err) {
        console.log(`  ✗ Failed to append insights: ${err}`);
      }
    }

    results.push({ project: projectPath, slug: projectSlug, insights: projectInsights });

    if (projectInsights === 0) {
      console.log(`○ [${projectSlug}] No new insights imported`);
    } else {
      console.log(`✓ [${projectSlug}] Imported ${projectInsights} insight(s)`);
    }
  }

  console.log("---");
  console.log(`Summary: ${totalInsightsImported} total insights imported across ${totalProjectsProcessed} projects`);

  for (const result of results) {
    if (result.insights > 0) {
      console.log(`  • ${result.slug}: ${result.insights}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
