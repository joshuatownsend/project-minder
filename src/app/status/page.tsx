"use client";

import { StatusDashboard } from "@/components/StatusDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Status");
  return (
    <div className="shell-content wide">
      <StatusDashboard />
    </div>
  );
}
