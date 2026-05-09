import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { SessionAdapter, SessionFile } from "./types";
import type { UsageTurn } from "@/lib/usage/types";
import {
  parseSessionTurns,
  parseSessionTurnsWithMeta,
  type SessionTurnsMeta,
} from "@/lib/usage/parser";

const claudeAdapter: SessionAdapter = {
  id: "claude",
  displayName: "Claude Code",

  async discover(): Promise<SessionFile[]> {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    const files: SessionFile[] = [];

    let subdirs: string[];
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    for (const dirName of subdirs) {
      const dirPath = path.join(projectsDir, dirName);
      let jsonlFiles: string[];
      try {
        const entries = await fs.readdir(dirPath);
        jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }

      for (const file of jsonlFiles) {
        files.push({
          source: "claude",
          filePath: path.join(dirPath, file),
          projectDirName: dirName,
        });
      }
    }

    return files;
  },

  async parseFile(file: SessionFile): Promise<UsageTurn[]> {
    const turns = await parseSessionTurns(file.filePath, file.projectDirName);
    return turns.map((t) => ({ ...t, source: "claude" }));
  },

  async parseFileWithMeta(
    file: SessionFile
  ): Promise<{ turns: UsageTurn[]; meta: SessionTurnsMeta }> {
    const { turns, meta } = await parseSessionTurnsWithMeta(
      file.filePath,
      file.projectDirName
    );
    return {
      turns: turns.map((t) => ({ ...t, source: "claude" })),
      meta,
    };
  },
};

export default claudeAdapter;
