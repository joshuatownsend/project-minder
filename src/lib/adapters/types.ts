import type { UsageTurn } from "@/lib/usage/types";
import type { SessionTurnsMeta } from "@/lib/usage/parser";

export interface SessionFile {
  source: string;
  filePath: string;
  projectDirName: string;
}

export interface SessionAdapter {
  id: string;
  displayName: string;
  discover(): Promise<SessionFile[]>;
  parseFile(file: SessionFile): Promise<UsageTurn[]>;
  parseFileWithMeta?(file: SessionFile): Promise<{ turns: UsageTurn[]; meta: SessionTurnsMeta }>;
}
