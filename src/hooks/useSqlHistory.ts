"use client";

import { useState, useCallback } from "react";

const STORAGE_KEY = "pm:sql-history";
const MAX_HISTORY = 20;

function loadHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or unavailable */
  }
}

export function useSqlHistory() {
  const [history, setHistory] = useState<string[]>(() => loadHistory());

  const pushHistory = useCallback((sql: string) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      // Dedup adjacent identical entries
      if (prev[0] === trimmed) return prev;
      const next = [trimmed, ...prev.filter((e) => e !== trimmed)].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    saveHistory([]);
    setHistory([]);
  }, []);

  return { history, pushHistory, clearHistory };
}
