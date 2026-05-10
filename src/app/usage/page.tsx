"use client";

import { UsageDashboard } from "@/components/UsageDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Usage");
  return (
    <div className="shell-content wide">
      <UsageDashboard />
    </div>
  );
}
