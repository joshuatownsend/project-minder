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

    let subdirs: string[];
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    const perDir = await Promise.all(
      subdirs.map(async (dirName) => {
        const dirPath = path.join(projectsDir, dirName);
        try {
          const entries = await fs.readdir(dirPath);
          return entries
            .filter((f) => f.endsWith(".jsonl"))
            .map((file) => ({
              source: "claude",
              filePath: path.join(dirPath, file),
              projectDirName: dirName,
            }));
        } catch {
          return [];
        }
      })
    );

    return perDir.flat();
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
