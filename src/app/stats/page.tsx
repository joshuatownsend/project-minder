"use client";

import { StatsDashboard } from "@/components/StatsDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Stats");
  return (
    <div className="shell-content wide">
      <StatsDashboard />
    </div>
  );
}
