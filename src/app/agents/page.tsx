"use client";

import { AgentsBrowser } from "@/components/AgentsBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function AgentsPage() {
  useDocumentTitle("Agents");
  return <AgentsBrowser />;
}
