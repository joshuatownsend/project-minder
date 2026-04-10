import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { InsightEntry } from "../src/lib/types";
import { parseInsightsFromJsonl } from "../src/lib/scanner/insightsMd";
import { appendInsights } from "../src/lib/insightsWriter";

/**
 * Encode a project path the same way Claude Code does for its project dirs.
 * C:\dev\project-minder → C--dev-project-minder
 */
function encodePath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}

function toSlug(dirName: string): string {
  return dirName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

async function main() {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");

  // Read devRoot from .minder.json (same as the app does)
  let devRoot = "C:\\dev";
  try {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), ".minder.json"), "utf-8"));
    if (config.devRoot) devRoot = config.devRoot;
  } catch {
    // Use default
  }

  console.log(`Scanning Claude history: ${claudeProjectsDir}`);
  console.log(`Dev root: ${devRoot}`);
  console.log("---");

  // Step 1: Build a map of encoded path → actual project path for all real projects
  const realProjects = new Map<string, string>(); // encoded → actual path
  try {
    const dirents = await fs.readdir(devRoot, { withFileTypes: true });
    for (const d of dirents) {
      if (d.isDirectory()) {
        const fullPath = path.join(devRoot, d.name);
        const encoded = encodePath(fullPath);
        realProjects.set(encoded, fullPath);
      }
    }
  } catch (err) {
    console.error(`Failed to read devRoot ${devRoot}:`, err);
    process.exit(1);
  }

  console.log(`Found ${realProjects.size} projects in ${devRoot}\n`);

  // Step 2: Scan Claude project dirs and match against real projects
  let claudeDirs: string[];
  try {
    claudeDirs = await fs.readdir(claudeProjectsDir);
  } catch (err) {
    console.error(`Failed to read ${claudeProjectsDir}:`, err);
    process.exit(1);
  }

  let totalInsights = 0;
  const results: Array<{ name: string; count: number }> = [];

  for (const dirName of claudeDirs) {
    const dirPath = path.join(claudeProjectsDir, dirName);
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) continue;

    // Match against real project paths
    const projectPath = realProjects.get(dirName);
    if (!projectPath) {
      // Not a project in our devRoot — skip silently
      continue;
    }

    const projectName = path.basename(projectPath);
    const projectSlug = toSlug(projectName);

    // Read all JSONL files
    let jsonlFiles: string[];
    try {
      const files = await fs.readdir(dirPath);
      jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    if (jsonlFiles.length === 0) continue;

    const allInsights: InsightEntry[] = [];

    for (const file of jsonlFiles) {
      const filePath = path.join(dirPath, file);
      const fstat = await fs.stat(filePath);
      if (fstat.size > 50 * 1024 * 1024) continue;

      const content = await fs.readFile(filePath, "utf-8");
      const sessionId = path.basename(file, ".jsonl");
      const insights = parseInsightsFromJsonl(content, sessionId, projectSlug, projectPath);
      allInsights.push(...insights);
    }

    if (allInsights.length === 0) {
      console.log(`  ${projectName}: no insights found`);
      continue;
    }

    const appended = await appendInsights(projectPath, allInsights);
    if (appended > 0) {
      console.log(`  ${projectName}: ${appended} insights imported`);
      totalInsights += appended;
      results.push({ name: projectName, count: appended });
    } else {
      console.log(`  ${projectName}: already up to date (${allInsights.length} existing)`);
    }
  }

  console.log(`\n---`);
  console.log(`Done. ${totalInsights} insights imported across ${results.length} projects.`);
  for (const r of results) {
    console.log(`  ${r.name}: ${r.count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
