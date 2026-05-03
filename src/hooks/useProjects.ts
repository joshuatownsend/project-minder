"use client";

import { useState, useEffect, useCallback } from "react";
import { ScanResult, ProjectData, ProjectStatus } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";

export function useProjects() {
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to fetch projects");
      const result = await res.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const rescan = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/scan", { method: "POST" });
      if (!res.ok) throw new Error("Failed to rescan");
      const result = await res.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      showToast("Rescan failed", "Showing cached results");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const updateStatus = useCallback(
    async (slug: string, status: ProjectStatus) => {
      try {
        const res = await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, status }),
        });
        if (!res.ok) return;
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            projects: prev.projects.map((p) =>
              p.slug === slug ? { ...p, status } : p
            ),
          };
        });
      } catch {
        // network errors — local state left unchanged
      }
    },
    []
  );

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const archiveProject = useCallback(
    (slug: string) => updateStatus(slug, "archived"),
    [updateStatus]
  );

  const unarchiveProject = useCallback(
    (slug: string, status: ProjectStatus = "active") => updateStatus(slug, status),
    [updateStatus]
  );

  return { data, loading, error, rescan, updateStatus, archiveProject, unarchiveProject };
}

export function useProject(slug: string) {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // `fetch` resolves on 4xx/5xx — must gate on `res.ok` or the
    // route's error body (e.g. `{error: "Project not found"}` from a
    // 404) becomes `project` and the consumer renders against a
    // malformed shape. ProjectDetail crashed on `dockerPorts.length`
    // when this hook wasn't checking status.
    let cancelled = false;
    fetch(`/api/projects/${slug}`)
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as ProjectData) : null;
        if (cancelled) return;
        setProject(data);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setProject(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { project, loading };
}
