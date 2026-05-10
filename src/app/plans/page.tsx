"use client";

import { PlansBrowser } from "@/components/PlansBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Plans");
  return (
    <div className="shell-content wide">
      <PlansBrowser />
    </div>
  );
}
