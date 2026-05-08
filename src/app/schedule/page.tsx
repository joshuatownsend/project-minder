"use client";

import Link from "next/link";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SchedulePage() {
  useDocumentTitle("Schedule");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "80px 24px",
        textAlign: "center",
        gap: "12px",
      }}
    >
      <div style={{ fontSize: "2rem" }}>🗓</div>
      <div style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}>
        Schedule — Coming in Wave 9.1b
      </div>
      <div
        style={{
          fontSize: "0.8rem",
          color: "var(--text-muted)",
          maxWidth: "400px",
          lineHeight: 1.6,
        }}
      >
        The cron materializer, schedule editor, and dispatcher loop ship in Wave 9.1b.
        Schedules can be created now via <code style={{ fontFamily: "var(--font-mono)" }}>/api/schedules</code> and
        will appear on the{" "}
        <Link href="/tasks" style={{ color: "var(--info)", textDecoration: "none" }}>
          Tasks
        </Link>{" "}
        page.
      </div>
    </div>
  );
}
