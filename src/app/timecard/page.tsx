import type { Metadata } from "next";
import { EngagementDashboard } from "@/components/EngagementDashboard";

// Reads live transcript data per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Timecard — Project Minder" };

export default function TimecardPage() {
  return (
    <div className="shell-content wide">
      <EngagementDashboard />
    </div>
  );
}
