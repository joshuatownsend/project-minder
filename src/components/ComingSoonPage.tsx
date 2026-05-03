"use client";

import Link from "next/link";

export interface ComingSoonProps {
  /** Human-readable title (e.g. "Plans browser"). */
  title: string;
  /** Wave number — surfaces in the body so the user knows when this lands. */
  wave: number;
  /** Cluster ID from the plan (e.g. "L"). Optional. */
  cluster?: string;
  /** TODO numbers this page satisfies. */
  todoRefs?: string[];
  /** One-paragraph description of the eventual feature. */
  blurb: string;
}

export function ComingSoonPage(props: ComingSoonProps) {
  const { title, wave, cluster, todoRefs, blurb } = props;
  return (
    <div style={{ maxWidth: "640px", padding: "32px 0" }}>
      <h1
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          color: "var(--text-primary)",
          margin: "0 0 8px 0",
        }}
      >
        {title}
      </h1>
      <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.6, margin: "0 0 20px 0" }}>
        {blurb}
      </p>
      <div
        style={{
          padding: "16px 18px",
          border: "1px dashed var(--border-default)",
          borderRadius: "var(--radius)",
          background: "var(--surface-1, transparent)",
          fontSize: "0.78rem",
          color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
        }}
      >
        Coming in <strong style={{ color: "var(--text-secondary)" }}>wave {wave}</strong>
        {cluster ? <span> (cluster {cluster})</span> : null}
        {todoRefs && todoRefs.length > 0 ? (
          <span>
            {" — "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.74rem" }}>
              TODO {todoRefs.join(", ")}
            </span>
          </span>
        ) : null}
        .
      </div>
      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "20px" }}>
        <Link href="/" style={{ color: "var(--info)", textDecoration: "none" }}>
          ← Back to projects
        </Link>
      </p>
    </div>
  );
}
