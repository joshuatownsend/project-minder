"use client";

import { useState, useEffect, useCallback } from "react";
import { BoardInfo } from "@/lib/types";

export interface BoardProjectView {
  slug: string;
  name: string;
  board: BoardInfo;
}

interface AllBoardsResult {
  projects: BoardProjectView[];
  totalEpics: number;
  totalIssues: number;
}

/** Cross-project board feed from `GET /api/board` (scan-cache backed). */
export function useAllBoards(
  projectFilter?: string,
  statusFilter?: string,
  query?: string,
) {
  const [data, setData] = useState<AllBoardsResult>({
    projects: [],
    totalEpics: 0,
    totalIssues: 0,
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (projectFilter) params.set("project", projectFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (query) params.set("q", query);
    const qs = params.toString();
    try {
      const res = await fetch(`/api/board${qs ? `?${qs}` : ""}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [projectFilter, statusFilter, query]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}

/** One project's board from `GET /api/board/[slug]` (fresh read). */
export function useProjectBoard(slug: string) {
  const [data, setData] = useState<BoardInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/board/${slug}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}
