import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface SkillUpdateStatus {
  id: string;
  hasUpdate: boolean;
  reason?: "behind-head" | "hash-mismatch" | "unknown";
  upstreamRef?: string;
  currentRef?: string;
  checkedAt: number;
  error?: string;
}

export type QueueItem =
  | {
      id: string;
      kind: "marketplace-plugin";
      marketplace: string;
      marketplaceRepo: string;
      gitCommitSha: string;
    }
  | {
      id: string;
      kind: "lockfile";
      sourceUrl: string;
      skillPath: string;
      skillFolderHash: string;
    };

const CACHE_TTL = 24 * 60 * 60_000; // 24 hours
const BATCH_SIZE = 5;
const BATCH_DELAY = 1200;

class SkillUpdateCache {
  private cache = new Map<string, SkillUpdateStatus>();
  private known = new Map<string, QueueItem>();
  private marketplaceHeads = new Map<string, string>();
  private queue: QueueItem[] = [];
  private activeBatch = 0;
  private running = false;
  private seen = new Set<string>();
  private gen = 0;

  enqueue(items: QueueItem[]) {
    for (const item of items) {
      this.known.set(item.id, item);
      const cached = this.cache.get(item.id);
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL) continue;
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      this.queue.push(item);
    }
    if (!this.running && this.queue.length > 0) {
      this.running = true;
      this.processQueue(this.gen);
    }
  }

  private async processQueue(myGen: number) {
    while (this.queue.length > 0 && this.gen === myGen) {
      const batch = this.queue.splice(0, BATCH_SIZE);
      this.activeBatch = batch.length;

      await Promise.all(
        batch.map(async (item) => {
          const status = await this.checkItem(item);
          if (this.gen === myGen) {
            if (status) this.cache.set(item.id, status);
            this.activeBatch--;
          }
        })
      );

      if (this.queue.length > 0 && this.gen === myGen) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }
    if (this.gen === myGen) {
      this.activeBatch = 0;
      this.running = false;
      this.seen.clear();
      this.marketplaceHeads.clear();
    }
  }

  private async checkItem(item: QueueItem): Promise<SkillUpdateStatus | null> {
    const base: SkillUpdateStatus = {
      id: item.id,
      hasUpdate: false,
      checkedAt: Date.now(),
    };

    try {
      if (item.kind === "marketplace-plugin") {
        return await this.checkMarketplacePlugin(item, base);
      }
      return await this.checkLockfileSkill(item, base);
    } catch (err) {
      return { ...base, error: String(err) };
    }
  }

  private async checkMarketplacePlugin(
    item: Extract<QueueItem, { kind: "marketplace-plugin" }>,
    base: SkillUpdateStatus
  ): Promise<SkillUpdateStatus> {
    const { marketplaceRepo, gitCommitSha } = item;
    const repoUrl = `https://github.com/${marketplaceRepo}.git`;

    let headSha = this.marketplaceHeads.get(repoUrl);
    if (!headSha) {
      headSha = await lsRemoteHead(repoUrl);
      if (headSha) this.marketplaceHeads.set(repoUrl, headSha);
    }

    if (!headSha) return base;

    const hasUpdate = headSha !== gitCommitSha;
    return {
      ...base,
      hasUpdate,
      reason: hasUpdate ? "behind-head" : undefined,
      upstreamRef: headSha.slice(0, 7),
      currentRef: gitCommitSha.slice(0, 7),
    };
  }

  private async checkLockfileSkill(
    item: Extract<QueueItem, { kind: "lockfile" }>,
    base: SkillUpdateStatus
  ): Promise<SkillUpdateStatus | null> {
    const { sourceUrl, skillPath, skillFolderHash } = item;

    const m = sourceUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!m) return base;
    const [, ownerRepo] = m;

    const dirPath = skillPath.replace(/\/SKILL\.md$/, "");
    const encodedPath = dirPath.split("/").map(encodeURIComponent).join("/");

    const apiUrl = `https://api.github.com/repos/${ownerRepo}/commits?path=${encodedPath}&sha=HEAD&per_page=1`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "project-minder",
    };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return null; // don't cache on HTTP errors (rate-limit, 404)

    const data = (await res.json()) as Array<{ sha?: string }>;
    const upstreamHash = data[0]?.sha;
    if (!upstreamHash) return base;

    const hasUpdate = upstreamHash !== skillFolderHash;
    return {
      ...base,
      hasUpdate,
      reason: hasUpdate ? "hash-mismatch" : undefined,
      upstreamRef: upstreamHash.slice(0, 7),
      currentRef: skillFolderHash.slice(0, 7),
    };
  }

  get(id: string): SkillUpdateStatus | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > CACHE_TTL) return null;
    return entry;
  }

  getAll(): Record<string, SkillUpdateStatus> {
    const result: Record<string, SkillUpdateStatus> = {};
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.checkedAt < CACHE_TTL) result[id] = entry;
    }
    return result;
  }

  refresh(ids?: string[]) {
    this.gen++;
    this.activeBatch = 0;
    if (ids) {
      for (const id of ids) this.cache.delete(id);
    } else {
      this.cache.clear();
    }
    this.seen.clear();
    this.queue = [];
    this.running = false;
    this.marketplaceHeads.clear();
    this.enqueue(Array.from(this.known.values()));
  }

  get pending(): number {
    return this.queue.length + this.activeBatch;
  }

  get total(): number {
    return this.cache.size;
  }
}

async function lsRemoteHead(repoUrl: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", repoUrl, "HEAD"], {
      timeout: 10_000,
    });
    const line = stdout.trim().split("\n")[0];
    const sha = line?.split("\t")[0]?.trim();
    return sha && sha.length === 40 ? sha : undefined;
  } catch {
    return undefined;
  }
}

const globalForSUC = globalThis as unknown as { __skillUpdateCache?: SkillUpdateCache };
export const skillUpdateCache =
  globalForSUC.__skillUpdateCache ||
  (globalForSUC.__skillUpdateCache = new SkillUpdateCache());
