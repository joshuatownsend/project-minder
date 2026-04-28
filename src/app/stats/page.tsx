"use client";

import { StatsDashboard } from "@/components/StatsDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function StatsPage() {
  useDocumentTitle("Stats");
  return <StatsDashboard />;
}
