"use client";

import { ManualStepsDashboard } from "@/components/ManualStepsDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Manual Steps");
  return (
    <div className="shell-content wide">
      <ManualStepsDashboard />
    </div>
  );
}
