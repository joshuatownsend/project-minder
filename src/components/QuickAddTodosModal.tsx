"use client";

import { useEffect, useMemo, useState } from "react";
import { ProjectData } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { X, Loader2, CheckCircle2, XCircle, Lightbulb } from "lucide-react";
import { useToast } from "./ToastProvider";

interface QuickAddTodosModalProps {
  projects: ProjectData[];
  open: boolean;
  onClose: () => void;
}

interface ProjectResult {
  slug: string;
  name: string;
  ok: boolean;
  error?: string;
  added?: number;
}

export function QuickAddTodosModal({
  projects,
  open,
  onClose,
}: QuickAddTodosModalProps) {
  const [search, setSearch] = useState("");
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<ProjectResult[] | null>(null);
  const { showToast } = useToast();

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset state each time the modal reopens
  useEffect(() => {
    if (open) {
      setSearch("");
      setSelectedSlugs(new Set());
      setText("");
      setResults(null);
      setSubmitting(false);
    }
  }, [open]);

  const visibleProjects = useMemo(() => {
    const active = projects.filter((p) => p.status !== "archived");
    if (!search) return active;
    const q = search.toLowerCase();
    return active.filter(
      (p) => p.name.toLowerCase().includes(q) || p.slug.includes(q)
    );
  }, [projects, search]);

  const items = useMemo(
    () =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    [text]
  );

  if (!open) return null;

  const toggleProject = (slug: string) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedSlugs(new Set(visibleProjects.map((p) => p.slug)));
  };

  const clearSelection = () => setSelectedSlugs(new Set());

  const submit = async () => {
    if (selectedSlugs.size === 0 || items.length === 0 || submitting) return;
    setSubmitting(true);
    setResults(null);

    const selected = projects.filter((p) => selectedSlugs.has(p.slug));
    const settled = await Promise.all(
      selected.map(async (p): Promise<ProjectResult> => {
        try {
          const res = await fetch(`/api/todos/${p.slug}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return {
              slug: p.slug,
              name: p.name,
              ok: false,
              error: body.error ?? `HTTP ${res.status}`,
            };
          }
          const body = await res.json();
          return {
            slug: p.slug,
            name: p.name,
            ok: true,
            added: body.added ?? items.length,
          };
        } catch (err) {
          return {
            slug: p.slug,
            name: p.name,
            ok: false,
            error: err instanceof Error ? err.message : "Network error",
          };
        }
      })
    );

    setResults(settled);
    setSubmitting(false);

    const successCount = settled.filter((r) => r.ok).length;
    const failCount = settled.length - successCount;
    showToast(
      failCount === 0
        ? `Added ${items.length} TODO${items.length !== 1 ? "s" : ""} to ${successCount} project${successCount !== 1 ? "s" : ""}`
        : `Added to ${successCount}, failed for ${failCount}`
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl mt-12 rounded-lg border bg-[var(--card)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b p-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-amber-400" />
            <h2 className="text-lg font-semibold">Quick Add TODOs</h2>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
          {/* Project picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                Projects ({selectedSlugs.size} selected)
              </label>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={selectAllVisible}
                  disabled={visibleProjects.length === 0}
                >
                  All visible
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearSelection}
                  disabled={selectedSlugs.size === 0}
                >
                  Clear
                </Button>
              </div>
            </div>
            <Input
              placeholder="Filter projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="h-80 overflow-y-auto rounded-md border">
              {visibleProjects.length === 0 ? (
                <p className="p-3 text-sm text-[var(--muted-foreground)]">
                  No projects match.
                </p>
              ) : (
                <ul>
                  {visibleProjects.map((p) => {
                    const checked = selectedSlugs.has(p.slug);
                    return (
                      <li key={p.slug}>
                        <label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--muted)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleProject(p.slug)}
                            className="shrink-0"
                          />
                          <span className="truncate">{p.name}</span>
                          {p.framework && (
                            <span className="ml-auto text-xs text-[var(--muted-foreground)] shrink-0">
                              {p.framework}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Idea input */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Ideas ({items.length} {items.length === 1 ? "item" : "items"})
            </label>
            <p className="text-xs text-[var(--muted-foreground)]">
              One TODO per line. Each line is appended as <code>- [ ] …</code>.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"Refactor the scanner batching\nAdd keyboard shortcuts to detail page\nInvestigate flaky git subprocess pool"}
              rows={12}
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            />

            {results && (
              <div className="max-h-40 overflow-y-auto rounded-md border text-xs">
                <ul>
                  {results.map((r) => (
                    <li
                      key={r.slug}
                      className="flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0"
                    >
                      {r.ok ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                      )}
                      <span className="truncate">{r.name}</span>
                      <span className="ml-auto text-[var(--muted-foreground)]">
                        {r.ok ? `+${r.added}` : r.error}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t p-4">
          <p className="text-xs text-[var(--muted-foreground)]">
            Will write to {selectedSlugs.size} × {items.length} ={" "}
            {selectedSlugs.size * items.length} TODO
            {selectedSlugs.size * items.length !== 1 ? "s" : ""}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={
                submitting || selectedSlugs.size === 0 || items.length === 0
              }
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Lightbulb className="h-4 w-4 mr-1" />
                  Add to {selectedSlugs.size || 0} project
                  {selectedSlugs.size !== 1 ? "s" : ""}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
