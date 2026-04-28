"use client";

import { UsageDashboard } from "@/components/UsageDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function UsagePage() {
  useDocumentTitle("Usage");
  return <UsageDashboard />;
}
