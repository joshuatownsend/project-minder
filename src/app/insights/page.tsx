"use client";

import { InsightsBrowser } from "@/components/InsightsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function InsightsPage() {
  useDocumentTitle("Insights");
  return <InsightsBrowser />;
}
