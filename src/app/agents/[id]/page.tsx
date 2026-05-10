"use client";

import { use } from "react";
import { AgentDetailView } from "@/components/AgentDetailView";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  useDocumentTitle(`Agent · ${id}`);
  return (
    <div className="shell-content wide">
      <AgentDetailView id={id} />
    </div>
  );
}
