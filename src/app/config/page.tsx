"use client";

import { ConfigDashboard } from "@/components/ConfigDashboard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function ConfigPage() {
  useDocumentTitle("Config");
  return <ConfigDashboard />;
}
