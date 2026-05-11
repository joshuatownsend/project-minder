"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Provenance } from "@/lib/indexer/types";
import {
  formatFrontmatterValue,
  frontmatterTableEntries,
  versionRows,
} from "@/lib/catalogDetail";
import { MarkdownRenderer } from "./ui/MarkdownRenderer";

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "0.7rem",
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
        textDecoration: "none",
        alignSelf: "flex-start",
      }}
    >
      <ArrowLeft style={{ width: "12px", height: "12px" }} />
      {label}
    </Link>
  );
}

export function NotFoundPanel({
  backHref,
  backLabel,
  message,
}: {
  backHref: string;
  backLabel: string;
  message: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <BackLink href={backHref} label={`Back to ${backLabel.toLowerCase()}`} />
      <div
        style={{
          padding: "32px",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.78rem",
          textAlign: "center",
        }}
      >
        {message}
      </div>
    </div>
  );
}

export function MetaPill({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontFamily: "var(--font-mono)",
        fontSize: "0.62rem",
        color: "var(--text-muted)",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "2px 6px",
      }}
    >
      <span style={{ opacity: 0.7 }}>{label}:</span>
      <span style={{ color: "var(--text-secondary)" }}>{value}</span>
    </span>
  );
}

export function DetailHeader({
  name,
  description,
  provenance,
  meta,
}: {
  name: string;
  description?: string;
  provenance: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <h1
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "1.4rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: 0,
          }}
        >
          {name}
        </h1>
        {provenance}
        {meta && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            {meta}
          </div>
        )}
      </div>
      {description && (
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.85rem",
            color: "var(--text-secondary)",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>
      )}
    </header>
  );
}

export function OverviewTab({
  frontmatter,
  provenanceDetails,
  extraSections,
}: {
  frontmatter: Record<string, unknown>;
  provenanceDetails?: ReactNode;
  extraSections?: ReactNode;
}) {
  const entries = frontmatterTableEntries(frontmatter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", paddingTop: "12px" }}>
      {provenanceDetails}
      {extraSections}
      {entries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Frontmatter
          </span>
          <table
            style={{
              borderCollapse: "collapse",
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
            }}
          >
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <td
                    style={{
                      verticalAlign: "top",
                      padding: "4px 12px 4px 0",
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {key}
                  </td>
                  <td
                    style={{
                      verticalAlign: "top",
                      padding: "4px 0",
                      color: "var(--text-primary)",
                      wordBreak: "break-word",
                    }}
                  >
                    {formatFrontmatterValue(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function BodyTab({ content, filePath }: { content: string; filePath: string }) {
  if (!content) {
    return (
      <div
        style={{
          padding: "20px",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.78rem",
          textAlign: "center",
        }}
      >
        No body content.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", paddingTop: "12px" }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          color: "var(--text-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={filePath}
      >
        {filePath}
      </span>
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          padding: "14px 16px",
        }}
      >
        <MarkdownRenderer content={content} />
      </div>
    </div>
  );
}

export function VersionsTab({ provenance }: { provenance: Provenance }) {
  const rows = versionRows(provenance);
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: "20px",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.78rem",
          textAlign: "center",
        }}
      >
        Not version-tracked. Versions are surfaced for marketplace-plugin items only.
      </div>
    );
  }

  return (
    <div style={{ paddingTop: "12px" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
        }}
      >
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td
                style={{
                  padding: "4px 16px 4px 0",
                  color: "var(--text-muted)",
                  whiteSpace: "nowrap",
                  verticalAlign: "top",
                }}
              >
                {r.label}
              </td>
              <td
                style={{
                  padding: "4px 0",
                  color: "var(--text-primary)",
                  wordBreak: "break-all",
                  verticalAlign: "top",
                }}
              >
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

