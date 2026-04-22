"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { LiveSession } from "@/lib/types";

const navItems = [
  { href: "/manual-steps", label: "Steps",    badge: "steps"    },
  { href: "/insights",     label: "Insights"                    },
  { href: "/sessions",     label: "Sessions"                    },
  { href: "/status",       label: "Status",   badge: "approval" },
  { href: "/usage",        label: "Usage"                       },
  { href: "/stats",        label: "Stats"                       },
  { href: "/config",       label: "Config"                      },
  { href: "/setup",        label: "Setup"                       },
];

export function AppNav() {
  const pathname = usePathname();
  const [stepsPending, setStepsPending] = useState(0);
  const [statusApproval, setStatusApproval] = useState(0);

  useEffect(() => {
    async function fetchPending() {
      try {
        const res = await fetch("/api/manual-steps?pending=true");
        if (!res.ok) return;
        const data = await res.json();
        const total = data.reduce(
          (sum: number, p: { manualSteps: { pendingSteps: number } }) =>
            sum + p.manualSteps.pendingSteps,
          0
        );
        setStepsPending(total);
      } catch {
        // ignore
      }
    }
    fetchPending();
    const id = setInterval(fetchPending, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    async function fetchApproval() {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) return;
        const data = await res.json() as { sessions: LiveSession[] };
        const count = data.sessions?.filter((s) => s.status === "approval").length ?? 0;
        setStatusApproval(count);
      } catch {
        // ignore
      }
    }
    fetchApproval();
    const id = setInterval(fetchApproval, 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <nav style={{ display: "flex", alignItems: "center", gap: "2px" }}>
      {navItems.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(item.href + "/");
        const badgeCounts: Record<string, number> = { steps: stepsPending, approval: statusApproval };
        const badgeCount = item.badge ? (badgeCounts[item.badge] ?? 0) : 0;
        const showBadge = badgeCount > 0;

        return (
          <Link
            key={item.href}
            href={item.href}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              padding: "4px 10px",
              borderRadius: "var(--radius)",
              fontSize: "0.7rem",
              fontWeight: 500,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontFamily: "var(--font-body)",
              textDecoration: "none",
              color: isActive ? "var(--accent)" : "var(--text-secondary)",
              background: isActive ? "var(--accent-bg)" : "transparent",
              transition: "color 0.12s, background 0.12s",
            }}
          >
            {item.label}
            {showBadge && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.65rem",
                  fontWeight: 600,
                  letterSpacing: 0,
                  textTransform: "none",
                  background: "var(--accent-bg)",
                  color: "var(--accent)",
                  border: "1px solid var(--accent-border)",
                  borderRadius: "3px",
                  padding: "0 4px",
                  lineHeight: "1.4",
                }}
              >
                {badgeCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
