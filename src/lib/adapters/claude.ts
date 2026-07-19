import path from "path";
import { promises as fs } from "fs";
import { readConfig } from "@/lib/config";
import { getReadableClaudeHomes } from "@/lib/claudeHome";
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
    // Every readable Claude home (primary + config.claudeHomes); a home
    // inside a stopped WSL distro is skipped for the cycle, never woken.
    const config = await readConfig();
    const homes = await getReadableClaudeHomes(config);

    const subdirs: { home: string; dirName: string }[] = [];
    for (const home of homes) {
      try {
        const entries = await fs.readdir(path.join(home, "projects"), { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) subdirs.push({ home, dirName: e.name });
        }
      } catch {
        // No projects dir in this home
      }
    }

    const perDir = await Promise.all(
      subdirs.map(async ({ home, dirName }) => {
        const dirPath = path.join(home, "projects", dirName);
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
