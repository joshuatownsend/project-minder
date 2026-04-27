"use client";

import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { X, Eye, EyeOff } from "lucide-react";
import { MinderConfig } from "@/lib/types";

interface ManageHiddenProjectsProps {
  onClose: () => void;
  onUnhide: () => void; // triggers rescan after unhiding
}

export function ManageHiddenProjects({
  onClose,
  onUnhide,
}: ManageHiddenProjectsProps) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((config: MinderConfig) => {
        setHidden(config.hidden);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const unhide = async (dirName: string) => {
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unhide", dirName }),
    });
    setHidden((prev) => prev.filter((d) => d !== dirName));
    onUnhide();
  };

  const unhideAll = async () => {
    if (!window.confirm(`Unhide all ${hidden.length} projects?`)) return;
    // Unhide one by one (API doesn't support bulk, but we can send bulk hidden=[])
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: [] }),
    });
    setHidden([]);
    onUnhide();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--bg-base)]/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[var(--card)] border rounded-lg shadow-lg w-full max-w-md max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <EyeOff className="h-4 w-4" />
            <h2 className="font-semibold">Hidden Projects</h2>
            <span className="text-xs text-[var(--muted-foreground)]">
              ({hidden.length})
            </span>
          </div>
          <div className="flex items-center gap-2">
            {hidden.length > 0 && (
              <Button variant="ghost" size="sm" onClick={unhideAll}>
                Unhide All
              </Button>
            )}
            <button
              onClick={onClose}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-4">
          {loading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
          ) : hidden.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)] text-center py-4">
              No hidden projects.
            </p>
          ) : (
            <ul className="space-y-1">
              {hidden.sort().map((dirName) => (
                <li
                  key={dirName}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[var(--muted)] transition-colors"
                >
                  <span className="text-sm font-mono truncate">{dirName}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => unhide(dirName)}
                    className="shrink-0"
                  >
                    <Eye className="h-3 w-3 mr-1" />
                    Unhide
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
