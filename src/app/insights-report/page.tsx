import type { Metadata } from "next";
import { InsightsReportViewer } from "@/components/InsightsReportViewer";

export const metadata: Metadata = { title: "Insights Report — Project Minder" };

export default function InsightsReportPage() {
  return (
    <div className="shell-content wide">
      <InsightsReportViewer />
    </div>
  );
}
