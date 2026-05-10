"use client";

import { use } from "react";
import { SessionDetailView } from "@/components/SessionDetailView";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  useDocumentTitle("Session");
  return (
    <div className="shell-content wide">
      <SessionDetailView sessionId={sessionId} />
    </div>
  );
}
