"use client";

import { useState, useEffect } from "react";
import type { LintFinding, ScanResult } from "@/lib/types";

interface LintFindingsResult {
  findingsByFile: Map<string, LintFinding[]>;
  projectSlugByFile: Map<string, string>;
  isLoading: boolean;
}

/**
 * Fetches the full scan result and indexes lint findings by file path for
 * fast per-entry badge lookup in the Agents, Skills, Commands, and Plugins
 * browsers.
 *
 * Two maps are returned:
 * - `findingsByFile` — all findings keyed by `finding.file`
 * - `projectSlugByFile` — project slug for each file (enables click-to-tab links)
 *
 * Catalog-level findings (from `catalogLintFindings`) that have no associated
 * project slug are included in `findingsByFile` but not in `projectSlugByFile`,
 * so their chips render without a link.
 */
export function useLintFindings(): LintFindingsResult {
  const [result, setResult] = useState<LintFindingsResult>({
    findingsByFile: new Map(),
    projectSlugByFile: new Map(),
    isLoading: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((res) => (res.ok ? (res.json() as Promise<ScanResult>) : Promise.reject()))
      .then((scan) => {
        if (cancelled) return;

        const findingsByFile = new Map<string, LintFinding[]>();
        const projectSlugByFile = new Map<string, string>();

        const addFinding = (f: LintFinding, slug?: string) => {
          if (!f.file) return;
          const bucket = findingsByFile.get(f.file) ?? [];
          bucket.push(f);
          findingsByFile.set(f.file, bucket);
          if (slug) projectSlugByFile.set(f.file, slug);
        };

        for (const project of scan.projects) {
          for (const f of project.configLint?.findings ?? []) {
            addFinding(f, project.slug);
          }
        }

        for (const f of scan.catalogLintFindings ?? []) {
          addFinding(f);
        }

        setResult({ findingsByFile, projectSlugByFile, isLoading: false });
      })
      .catch(() => {
        if (!cancelled) setResult((prev) => ({ ...prev, isLoading: false }));
      });
    return () => { cancelled = true; };
  }, []);

  return result;
}
