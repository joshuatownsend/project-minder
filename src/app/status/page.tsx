"use client";

import { StatusDashboard } from "@/components/StatusDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function StatusPage() {
  useDocumentTitle("Status");
  return <StatusDashboard />;
}
