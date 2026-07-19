"use client";

import { useState } from "react";
import { FolderSearch, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface FirstRunSetupProps {
  /** The paths the server probed and did not find — shown so the prompt is concrete. */
  candidates: string[];
  /** Called after the root is saved and a rescan has been kicked off. */
  onComplete: () => void;
  /** Called when the user dismisses setup without choosing a root. */
  onSkip: () => void;
}

/**
 * Shown when `GET /api/first-run` reports `firstRun` — a fresh install on a
 * machine with no conventional project directory.
 *
 * There is no directory picker here on purpose: the browser's file APIs cannot
 * hand a server-side process an absolute filesystem path (`showDirectoryPicker`
 * yields a sandboxed handle, and `<input webkitdirectory>` yields relative
 * paths plus a full file list). Minder's scanner needs a real path on the
 * machine running the server, so a text field pre-seeded with the paths we
 * actually probed is the honest interaction.
 */
export function FirstRunSetup({ candidates, onComplete, onSkip }: FirstRunSetupProps) {
  const [value, setValue] = useState(candidates[0] ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const root = value.trim();
    if (!root) {
      setError("Enter the folder your projects live in.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devRoots: [root] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Could not save (HTTP ${res.status})`);
      }

      // Saving the root only records it — the dashboard reads from the scan
      // cache, so without an explicit rescan the user would stare at an empty
      // grid until the 5-minute TTL lapsed and conclude setup had failed.
      await fetch("/api/scan", { method: "POST" });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that folder.");
      setSaving(false);
    }
  }

  return (
    <div className="shell-content">
      <Card>
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start gap-3">
            <FolderSearch className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <h1 className="text-lg font-semibold">Where do you keep your projects?</h1>
              <p className="text-sm text-muted">
                Project Minder scans one folder for project directories. It only reads
                — nothing is modified, and nothing leaves this machine.
              </p>
            </div>
          </div>

          {candidates.length > 0 && (
            <p className="text-sm text-muted">
              We looked in{" "}
              {candidates.map((c, i) => (
                <span key={c}>
                  {i > 0 && (i === candidates.length - 1 ? " and " : ", ")}
                  <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">{c}</code>
                </span>
              ))}{" "}
              and didn&apos;t find either.
            </p>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="first-run-root" className="text-sm font-medium">
              Projects folder
            </label>
            <Input
              id="first-run-root"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !saving) save();
              }}
              placeholder={candidates[0] ?? "/path/to/your/projects"}
              disabled={saving}
              aria-describedby={error ? "first-run-error" : undefined}
              aria-invalid={error ? true : undefined}
            />
            {error && (
              <p id="first-run-error" role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {saving ? "Scanning…" : "Scan this folder"}
            </Button>
            <Button variant="ghost" onClick={onSkip} disabled={saving}>
              Skip for now
            </Button>
          </div>

          <p className="text-xs text-muted">
            You can change this any time in Settings → Scan Roots, and add more folders there.
          </p>
        </div>
      </Card>
    </div>
  );
}
