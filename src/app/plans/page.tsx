"use client";

import { PlansBrowser } from "@/components/PlansBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function PlansPage() {
  useDocumentTitle("Plans");
  return <PlansBrowser />;
}
