"use client";

import type { Provenance } from "@/lib/indexer/types";
import type { SkillUpdateStatus } from "@/lib/skillUpdateCache";

interface CatalogEntryLike {
  provenance: Provenance;
  realPath?: string;
  filePath: string;
}

export function CatalogActionStrip({
  entry,
  updateStatus,
}: {
  entry: CatalogEntryLike;
  updateStatus?: SkillUpdateStatus;
}) {
  const p = entry.provenance;
  const sourceUrl =
    p.kind === "marketplace-plugin"
      ? (p.pluginRepoUrl ?? (p.marketplaceRepo ? `https://github.com/${p.marketplaceRepo}` : null))
      : p.kind === "lockfile"
      ? p.sourceUrl
      : null;

  const commitSha =
    p.kind === "marketplace-plugin"
      ? p.gitCommitSha
      : p.kind === "lockfile"
      ? p.skillFolderHash
      : null;

  const installPath = entry.realPath ?? entry.filePath;

  async function revealInFolder(e: React.MouseEvent) {
    e.stopPropagation();
    await fetch("/api/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: installPath }),
    });
  }

  async function recheck(e: React.MouseEvent) {
    e.stopPropagation();
    await fetch("/api/catalog-updates/refresh", { method: "POST" });
  }

  function copy(e: React.MouseEvent, text: string) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).catch(() => undefined);
  }

  const btnStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    padding: "0 4px",
    fontSize: "0.62rem",
    fontFamily: "var(--font-body)",
    color: "var(--accent)",
    cursor: "pointer",
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "2px",
        marginTop: "2px",
      }}
    >
      {updateStatus?.hasUpdate && (
        <span
          style={{
            fontSize: "0.6rem",
            fontFamily: "var(--font-mono)",
            color: "var(--warning, #f59e0b)",
            marginRight: "4px",
          }}
        >
          update: {updateStatus.currentRef} → {updateStatus.upstreamRef}
        </span>
      )}
      {sourceUrl && (
        <a
          href={sourceUrl.startsWith("http") ? sourceUrl : `https://${sourceUrl}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ ...btnStyle, textDecoration: "none" }}
        >
          open source ↗
        </a>
      )}
      <button style={btnStyle} onClick={revealInFolder}>
        show in folder
      </button>
      {sourceUrl && (
        <button style={btnStyle} onClick={(e) => copy(e, sourceUrl)}>
          copy url
        </button>
      )}
      {commitSha && (
        <button style={btnStyle} onClick={(e) => copy(e, commitSha)}>
          copy sha
        </button>
      )}
      <button style={btnStyle} onClick={(e) => copy(e, installPath)}>
        copy path
      </button>
      <button
        style={{ ...btnStyle, color: "var(--text-muted)" }}
        onClick={recheck}
      >
        re-check
      </button>
    </div>
  );
}
