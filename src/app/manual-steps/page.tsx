"use client";

import { ManualStepsDashboard } from "@/components/ManualStepsDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function ManualStepsPage() {
  useDocumentTitle("Manual Steps");
  return <ManualStepsDashboard />;
}
